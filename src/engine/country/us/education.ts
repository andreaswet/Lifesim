/**
 * The US school system (design §7.12): kindergarten to twelfth grade, the SAT, admissions by
 * college tier, paying for college, and degrees. Every number comes from
 * content/countries/us/education/system.yaml; this file is the logic that cannot be a table.
 *
 * Achievement is in grade equivalents. A pupil learns at a rate set by aptitude, effort, the
 * school, the home, and what is going on at home; position among peers (z) comes from national
 * norms. Grades, test scores and admissions all read that position, so advantage and effort
 * reach outcomes through the same path, and each outcome can be explained.
 */

import type { EducationDef, TierDef } from '../../content/country-schema'
import { approach, clamp, dexp, dpow, logistic, logit } from '../../core/dmath'
import { KeyedRng } from '../../core/rng'
import { monthOf, yearOf } from '../../core/time'
import { emitFact, startProcess, type Ctx, type SourceClass } from '../../context'
import type { Prepared } from '../../content/prepare'
import { ageYears, householdOf, parentsOf, educationRank } from '../../people'
import { newId, type Decision, type GameState, type OutcomeRecord, type Person, type Scalar } from '../../state'
import { registerAction, registerHook } from '../../systems/actions'
import { hasOpenDecision, openDecision, plainText, registerSystemDecision } from '../../systems/decisions'
import { WORLD, acct, dollars, move } from '../../systems/money'
import { homeSupport, incomeZ, involvement, parentEducationZ, parentalStructure, realIncome } from './family'
import { payOut, unitHead } from './household'
import { workHours } from './work'

type Cfg = EducationDef

const GRADE_NAMES = ['kindergarten', 'first grade', 'second grade', 'third grade', 'fourth grade', 'fifth grade', 'sixth grade', 'seventh grade', 'eighth grade', 'ninth grade', 'tenth grade', 'eleventh grade', 'twelfth grade']

const LETTERS: Array<[number, string]> = [
  [3.85, 'A'],
  [3.5, 'A-'],
  [3.15, 'B+'],
  [2.85, 'B'],
  [2.5, 'B-'],
  [2.15, 'C+'],
  [1.85, 'C'],
  [1.5, 'C-'],
  [1.15, 'D+'],
  [0.7, 'D'],
]

export function letterGrade(points: number): string {
  for (const [floor, letter] of LETTERS) if (points >= floor) return letter
  return 'F'
}

function cfgOf(content: Prepared): Cfg {
  return content.bundle.country.education
}

/**
 * Draws that describe a person or a place rather than an event (how set on college someone is,
 * what the local college is called) are read many times and must not trip the check for a key
 * drawn twice in one month, so they come from a plain generator on the same seed.
 */
const stableCache = new Map<string, KeyedRng>()
function stable(state: GameState): KeyedRng {
  let rng = stableCache.get(state.meta.seed)
  if (!rng) {
    if (stableCache.size > 64) stableCache.clear()
    rng = new KeyedRng(state.meta.seed)
    stableCache.set(state.meta.seed, rng)
  }
  return rng
}

/** A context for reading state where no step is in progress (automatic choices, the view). */
function reader(state: GameState, content: Prepared): Ctx {
  return { state, content, rng: stable(state), narrator: null, facts: [], interrupted: false }
}

function tell(ctx: Ctx, person: Person, kind: string, data: Record<string, Scalar>, options: { significant?: boolean; source?: SourceClass; outcomeId?: string } = {}): void {
  emitFact(
    ctx,
    { kind, subject: person, data, significant: options.significant ?? false, ...(options.outcomeId ? { outcomeId: options.outcomeId } : {}) },
    { sourceClass: options.source ?? 'structural' },
  )
}

function calendarMonth(ctx: Ctx): number {
  return monthOf(ctx.state.now) + 1
}

function tierOf(cfg: Cfg, id: string): TierDef {
  const tier = cfg.tiers.find((t) => t.id === id)
  if (!tier) throw new Error(`Unknown college tier '${id}'`)
  return tier
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/** Start-year dollars as dollars of the day. School prices and aid rise with prices (design decision Q7). */
function today(ctx: Pick<Ctx, 'state'>, amount: number): number {
  return Math.round(amount * ctx.state.world.priceLevel)
}

/** Student debt owed now, in dollars of the day. */
function owed(ctx: Pick<Ctx, 'state'>, person: Person): number {
  return Math.round(-dollars(ctx.state, person.id, 'student') - dollars(ctx.state, person.id, 'private'))
}

// ---------------------------------------------------------------------------------------------
// Effort and strain
// ---------------------------------------------------------------------------------------------

/** What the pupil actually puts in: the chosen level, moved by temperament, parents and strain. */
export function effort(ctx: Ctx, person: Person): number {
  const study = cfgOf(ctx.content).k12.study
  const level = study.levels.find((l) => l.id === person.policies.study) ?? study.levels[0]!
  let value = level.effort + study.conscientiousness * (person.traits.conscientiousness ?? 0) + study.engagementBySex[person.sex] + study.strain * person.strain
  // Parents who impose structure keep a child from doing nothing at all, while the child lives with them.
  if (level.effort < 0 && ageYears(person, ctx.state.now) < 18) value += study.parentalStructure * Math.max(0, parentalStructure(ctx, person))
  return value
}

/** Asking more hours of a week than it has builds strain, slowly; rest takes it away faster. */
function strainMonth(ctx: Ctx, person: Person): void {
  const { content } = ctx
  const k12 = cfgOf(content).k12
  const study = k12.study.levels.find((l) => l.id === person.policies.study)
  const activity = content.bundle.body.activityLevels[content.activityIndex.get(person.policies.activity) ?? 0]
  const enrolled = person.education.status === 'k12' || person.education.status === 'college'
  // A job on top of school counts in full; for someone out of school, only the hours beyond a normal week.
  const job = workHours(content, person)
  const hours = (enrolled ? (study?.hoursPerWeek ?? 0) + job : Math.max(0, job - 40)) + (activity?.hoursPerWeek ?? 0)
  const free = k12.load.freeHours + k12.load.perConscientiousness * (person.traits.conscientiousness ?? 0)
  const target = clamp((hours - free) / k12.load.fullStrainAtExtraHours, 0, 1)
  person.strain = approach(person.strain, target, k12.load.strainRiseMonths, k12.load.strainFallMonths)
}

// ---------------------------------------------------------------------------------------------
// Kindergarten to twelfth grade
// ---------------------------------------------------------------------------------------------

function subjectAptitude(cfg: Cfg, person: Person, aptitude: string): number {
  const own = person.aptitudes[aptitude] ?? 0
  const others = Object.entries(person.aptitudes).filter(([id]) => id !== aptitude)
  const other = others.length ? others.reduce((a, [, v]) => a + v, 0) / others.length : own
  return (1 - cfg.k12.crossAptitude) * own + cfg.k12.crossAptitude * other
}

function norm(content: Prepared, subject: string, grade: number): { mean: number; sd: number } {
  const table = content.bundle.country.norms[subject] as { mean: number[]; sd: number[] } | undefined
  const g = clamp(grade, 0, 12)
  return table ? { mean: table.mean[g]!, sd: table.sd[g]! } : { mean: g + 1, sd: 1 }
}

function schoolFor(ctx: Ctx, person: Person, grade: number): NonNullable<Person['education']['school']> {
  const home = householdOf(ctx.state, person)
  const names = ctx.content.bundle.country.schools
  const stage = grade <= 5 ? 'elementary' : grade <= 8 ? 'middle' : 'high'
  return {
    name: home ? home.schools[stage] : names[stage][0]!,
    quality: home ? home.schools.quality : 0,
    teacher: ctx.rng.pick(names.teachers, 'edu.teacher', person.id, grade),
  }
}

function readinessZ(ctx: Ctx, person: Person, aptitude: string, home: number): number {
  const r = cfgOf(ctx.content).k12.readiness
  return r.aptitude * subjectAptitude(cfgOf(ctx.content), person, aptitude) + r.home * home + r.noise * ctx.rng.normal('edu.readiness', person.id, aptitude)
}

function enroll(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  const home = homeSupport(ctx, person)
  let total = 0
  for (const subject of cfg.k12.subjects) {
    const z = readinessZ(ctx, person, subject.aptitude, home)
    person.skills[subject.id] = cfg.k12.readiness.sd * z
    total += z
  }
  const edu = person.education
  edu.status = 'k12'
  edu.grade = 0
  edu.school = schoolFor(ctx, person, 0)
  edu.standing = total / cfg.k12.subjects.length
  tell(ctx, person, 'school_started', { school: edu.school.name, teacher: edu.school.teacher }, { significant: true })
}

/** The log of a pupil's rate of learning in one subject this month (design §7.12). */
function logLearningRate(ctx: Ctx, person: Person, aptitude: string, subject: string, grade: number, includeNoise: boolean): number {
  const cfg = cfgOf(ctx.content)
  const L = cfg.k12.learning
  const home = householdOf(ctx.state, person)
  const level = cfg.k12.courseLevels.find((c) => c.id === person.education.courseLevel)
  const fit = level && level.rigor > 0 ? L.courseFit * level.rigor * (person.education.standing >= level.recommendedZ ? 1 : -1) : 0
  return (
    L.aptitude * subjectAptitude(cfg, person, aptitude) +
    L.effort * effort(ctx, person) +
    L.school * (person.education.school?.quality ?? 0) +
    L.home * homeSupport(ctx, person) +
    L.disruption * Math.min(1.5, home?.disruption ?? 0) +
    L.strain * person.strain +
    fit +
    // One draw per pupil, subject and school year: the luck of the teacher and the class.
    (includeNoise ? L.yearNoise * ctx.rng.normal('edu.year', person.id, subject, grade) : 0)
  )
}

function learn(ctx: Ctx, person: Person, inSession: boolean): void {
  const cfg = cfgOf(ctx.content)
  const grade = person.education.grade ?? 0
  if (inSession) {
    for (const subject of cfg.k12.subjects) {
      person.skills[subject.id] = (person.skills[subject.id] ?? 0) + dexp(logLearningRate(ctx, person, subject.aptitude, subject.id, grade, true)) / cfg.k12.schoolMonths.length
    }
  } else {
    const summerMonths = 12 - cfg.k12.schoolMonths.length
    const change = (cfg.k12.summer.base + cfg.k12.summer.home * homeSupport(ctx, person)) / summerMonths
    for (const subject of cfg.k12.subjects) person.skills[subject.id] = (person.skills[subject.id] ?? 0) + change
  }
}

function disengagementMonth(ctx: Ctx, person: Person): void {
  const D = cfgOf(ctx.content).k12.disengagement
  const edu = person.education
  const home = householdOf(ctx.state, person)
  const target = clamp(
    D.failing * (edu.lastReport && edu.lastReport.gpa < 1.5 ? 1 : 0) +
      D.lowAchievement * clamp(-edu.standing - 0.5, 0, 2) +
      D.disruption * Math.min(1, home?.disruption ?? 0) +
      D.lowInvolvement * clamp(-involvement(ctx, person), 0, 2) +
      D.conscientiousness * (person.traits.conscientiousness ?? 0),
    0,
    1,
  )
  edu.disengagement = approach(edu.disengagement, target, D.months, D.months)
}

/** Monthly chance that a pupil old enough to leave school does so. Also used by AI players. */
export function dropoutChance(state: GameState, content: Prepared, person: Person): number {
  const d = cfgOf(content).k12.dropout
  if (person.education.status !== 'k12' || ageYears(person, state.now) < d.minAge) return 0
  return Math.min(1, d.perMonthAtZero * dexp(d.steepness * person.education.disengagement))
}

function leaveSchool(ctx: Ctx, person: Person, how: 'dropped' | 'not_graduated'): void {
  const edu = person.education
  const grade = edu.grade ?? 0
  edu.status = 'left_k12'
  edu.grade = null
  edu.school = null
  edu.plan = null
  tell(ctx, person, 'school_left', { which: how, grade, gradeName: GRADE_NAMES[grade] ?? '' }, { significant: true, source: 'player' })
}

function reportCard(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  const G = cfg.k12.grades
  const edu = person.education
  const grade = edu.grade ?? 0
  const level = cfg.k12.courseLevels.find((c) => c.id === edu.courseLevel) ?? cfg.k12.courseLevels[0]!
  const e = effort(ctx, person)
  const points: Record<string, number> = {}
  let zSum = 0
  let pointSum = 0
  for (const subject of cfg.k12.subjects) {
    const n = norm(ctx.content, subject.id, grade)
    const z = ((person.skills[subject.id] ?? 0) - n.mean) / n.sd
    zSum += z
    const p = clamp(G.mean + G.achievement * z + G.effort * e - level.gradePenalty + G.noise * ctx.rng.normal('edu.grade', person.id, subject.id, grade), 0, 4)
    points[subject.id] = round2(p)
    pointSum += p
  }
  const count = cfg.k12.subjects.length
  const gpa = round2(pointSum / count)
  const previous = edu.lastReport?.gpa ?? null
  edu.lastReport = { grade, points, gpa, skills: { ...person.skills } }
  edu.standing = zSum / count
  if (grade >= 9) {
    edu.hs.gpaSum += gpa
    edu.hs.years += 1
    edu.hs.rigorSum += level.rigor
  }

  const sorted = cfg.k12.subjects.map((s) => ({ s, p: points[s.id]! })).sort((a, b) => b.p - a.p)
  const best = sorted[0]!
  const worst = sorted[sorted.length - 1]!
  tell(
    ctx,
    person,
    'report_card',
    {
      grade,
      gradeName: GRADE_NAMES[grade] ?? '',
      gpa,
      which: gpa >= 3.5 ? 'strong' : gpa >= 2.7 ? 'solid' : gpa >= 1.9 ? 'mixed' : gpa >= 1.0 ? 'poor' : 'failing',
      best: best.s.label,
      bestLetter: letterGrade(best.p),
      worst: worst.s.label,
      worstLetter: letterGrade(worst.p),
      even: best.p - worst.p < 0.5,
      change: previous === null ? 'first' : gpa - previous > 0.35 ? 'up' : gpa - previous < -0.35 ? 'down' : 'same',
    },
    { source: 'player', significant: previous !== null && Math.abs(gpa - previous) > 0.6 },
  )

  // A teacher sometimes says what the grades alone do not: where ability and effort part ways.
  if (ctx.rng.chance(0.3, 'edu.note', person.id, grade)) {
    const gap = (person.aptitudes.quantitative ?? 0) - (person.aptitudes.verbal ?? 0)
    const ability = ((person.aptitudes.quantitative ?? 0) + (person.aptitudes.verbal ?? 0)) / 2
    const note = ability > 0.6 && e < -0.4 ? 'coasting' : ability < -0.5 && e > 0.5 ? 'working_hard' : gap > 0.8 ? 'ahead_math' : gap < -0.8 ? 'ahead_reading' : edu.standing > 1.1 ? 'ahead' : edu.standing < -1.1 ? 'behind' : null
    // Said once; a teacher repeats it only if it has changed.
    if (note && person.flags['edu.lastNote'] !== note) {
      person.flags['edu.lastNote'] = note
      tell(ctx, person, 'teacher_note', { which: note, teacher: edu.school?.teacher ?? '', grade }, { source: 'player' })
    }
  }
}

export function hsGpa(person: Person): number | null {
  return person.education.hs.years > 0 ? round2(person.education.hs.gpaSum / person.education.hs.years) : null
}

function graduateOrNot(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  const edu = person.education
  const gpa = hsGpa(person) ?? 0
  if (gpa < cfg.k12.graduationGpa) {
    leaveSchool(ctx, person, 'not_graduated')
    return
  }
  const school = edu.school?.name ?? ''
  edu.status = 'out'
  edu.level = 'high_school'
  edu.grade = null
  edu.school = null
  tell(ctx, person, 'hs_graduated', { gpa, school, plan: edu.plan?.name ?? null, which: edu.plan ? 'college' : 'no_plan' }, { significant: true, source: 'player' })
}

// ---------------------------------------------------------------------------------------------
// Course level, the test, applications
// ---------------------------------------------------------------------------------------------

function recommendedLevel(cfg: Cfg, person: Person, grade: number): string {
  let best = cfg.k12.courseLevels[0]!
  for (const level of cfg.k12.courseLevels) if (grade >= level.fromGrade && person.education.standing >= level.recommendedZ && level.rigor >= best.rigor) best = level
  return best.id
}

function offerCourseLevel(ctx: Ctx, person: Person, grade: number): void {
  const cfg = cfgOf(ctx.content)
  const open = cfg.k12.courseLevels.filter((c) => grade >= c.fromGrade)
  const recommended = recommendedLevel(cfg, person, grade)
  // Nothing to decide if only the regular track is open and that is where the pupil is.
  if (open.length < 2 || (recommended === person.education.courseLevel && recommended === 'regular')) return
  openDecision(ctx, {
    source: 'system:edu.course',
    subject: person,
    class: 'deferrable',
    deadlineMonths: 1,
    promptId: 'prompt.edu.course',
    promptData: { grade, gradeName: GRADE_NAMES[grade] ?? '', recommended: cfg.k12.courseLevels.find((c) => c.id === recommended)?.label ?? '', current: person.education.courseLevel },
    options: open.map((c) => ({ id: c.id, label: plainText(ctx, 'label.edu.course', person, { label: c.label, recommended: c.id === recommended }) })),
    optional: false,
    sourceClass: 'structural',
  })
}

registerSystemDecision('edu.course', {
  resolve(ctx, _decision, subject, optionId, lapsed) {
    const from = subject.education.courseLevel
    subject.education.courseLevel = optionId
    const label = cfgOf(ctx.content).k12.courseLevels.find((c) => c.id === optionId)?.label ?? optionId
    tell(ctx, subject, 'course_chosen', { which: optionId, label, changed: from !== optionId, lapsed }, { source: 'player' })
  },
  weights(state, content, decision, subject) {
    const recommended = recommendedLevel(cfgOf(content), subject, subject.education.grade ?? 9)
    // Most pupils take what is recommended; the conscientious sometimes reach a step higher.
    return decision.options.map((o) => (o.id === recommended ? 6 : 1 + Math.max(0, subject.traits.conscientiousness ?? 0) * (o.id !== 'regular' ? 1 : 0)))
  },
})

/** How set on college someone is, as a z-like score. Stable for a person: the noise is keyed. */
export function aspiration(ctx: Ctx, person: Person): number {
  const cfg = cfgOf(ctx.content)
  const A = cfg.choices.aspiration
  const gpa = hsGpa(person)
  const record = gpa === null ? person.education.standing : (gpa - cfg.admissions.gpaMean) / cfg.admissions.gpaSd
  const home = householdOf(ctx.state, person)
  return A.base + A.gpa * record + A.parentEducation * parentEducationZ(ctx, person) + A.income * (home ? incomeZ(ctx, home) : 0) + A.noise * stable(ctx.state).normal('edu.aspiration', person.id)
}

function offerTest(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  openDecision(ctx, {
    source: 'system:edu.test',
    subject: person,
    class: 'deferrable',
    deadlineMonths: 1,
    promptId: 'prompt.edu.test',
    promptData: { name: cfg.test.name },
    options: [
      { id: 'take', label: plainText(ctx, 'label.edu.take_test', person, { name: cfg.test.name }), cost: { money: today(ctx, cfg.test.fee), energy: 'low' } },
      { id: 'skip', label: plainText(ctx, 'label.edu.skip_test', person, { name: cfg.test.name }) },
    ],
    optional: false,
    sourceClass: 'structural',
  })
}

registerSystemDecision('edu.test', {
  resolve(ctx, _decision, subject, optionId, lapsed) {
    const cfg = cfgOf(ctx.content)
    if (optionId !== 'take') {
      tell(ctx, subject, 'test_skipped', { name: cfg.test.name, lapsed }, { source: 'player' })
      return
    }
    const grade = subject.education.grade ?? cfg.test.grade
    const section = (subjectId: string): number => {
      // Mid-year, so measured between last year's norm and this year's.
      const a = norm(ctx.content, subjectId, grade - 1)
      const b = norm(ctx.content, subjectId, grade)
      const z = ((subject.skills[subjectId] ?? 0) - (a.mean + b.mean) / 2) / ((a.sd + b.sd) / 2)
      const r = cfg.test.reliability
      const score = cfg.test.sectionMean + cfg.test.sectionSd * (r * z + Math.sqrt(1 - r * r) * ctx.rng.normal('edu.test', subject.id, subjectId))
      return clamp(Math.round(score / 10) * 10, 200, 800)
    }
    subject.education.test = { verbal: section('literacy'), math: section('math') }
    const total = subject.education.test.verbal + subject.education.test.math
    tell(ctx, subject, 'test_score', { name: cfg.test.name, total, verbal: subject.education.test.verbal, math: subject.education.test.math, which: total >= 1350 ? 'high' : total >= 1100 ? 'good' : total >= 950 ? 'middling' : 'low' }, { significant: true, source: 'player' })
  },
  weights(state, content, _decision, subject) {
    const cfg = cfgOf(content)
    const p = logistic(cfg.choices.takeTest.base + cfg.choices.takeTest.aspiration * aspiration(reader(state, content), subject))
    return [p, 1 - p]
  },
})

function offerApplications(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  openDecision(ctx, {
    source: 'system:edu.apply',
    subject: person,
    class: 'deferrable',
    deadlineMonths: 2,
    promptId: 'prompt.edu.apply',
    promptData: { gpa: hsGpa(person), hasTest: person.education.test !== null, total: person.education.test ? person.education.test.verbal + person.education.test.math : null },
    options: cfg.admissions.strategies.map((s) => ({ id: s.id, label: s.label, ...(s.fee > 0 ? { cost: { money: today(ctx, s.fee), energy: s.tiers.length > 2 ? ('high' as const) : ('moderate' as const) } } : {}) })),
    optional: false,
    sourceClass: 'structural',
  })
}

registerSystemDecision('edu.apply', {
  resolve(ctx, _decision, subject, optionId, lapsed) {
    subject.flags['edu.strategy'] = optionId
    const strategy = cfgOf(ctx.content).admissions.strategies.find((s) => s.id === optionId)
    tell(ctx, subject, 'applied', { which: optionId, count: strategy?.tiers.length ?? 0, lapsed }, { source: 'player' })
  },
  weights(state, content, decision, subject) {
    const cfg = cfgOf(content)
    const a = aspiration(reader(state, content), subject)
    return decision.options.map((o) => {
      const w = cfg.choices.strategy[o.id]
      return w ? dexp(w.base + w.aspiration * a) : 0
    })
  },
})

/** The applicant's record as colleges weigh it: each part as a z-score among applicants. */
function admissionsRecord(cfg: Cfg, person: Person): { gpa: number; test: number | null; rigor: number } {
  const A = cfg.admissions
  const gpa = ((hsGpa(person) ?? A.gpaMean) - A.gpaMean) / A.gpaSd
  const test = person.education.test ? (person.education.test.verbal + person.education.test.math - A.testMean) / A.testSd : null
  const rigor = person.education.hs.years > 0 ? (person.education.hs.rigorSum / person.education.hs.years - 0.5) / 0.6 : -0.8
  return { gpa, test, rigor }
}

function institutionName(ctx: Ctx, person: Person, tier: TierDef): string {
  const home = householdOf(ctx.state, person)
  // One name per tier per state, so siblings and neighbors talk about the same places.
  return stable(ctx.state).pick(tier.names, 'edu.institution', home?.state ?? '', tier.id)
}

/** Decides one application with the named-factor model (design §3.2) and records why. */
function decideApplication(ctx: Ctx, person: Person, tier: TierDef): void {
  const { state } = ctx
  const cfg = cfgOf(ctx.content)
  const W = cfg.admissions.weights
  const record = admissionsRecord(cfg, person)
  const factors: OutcomeRecord['factors'] = []
  const add = (id: string, contribution: number): void => {
    if (Math.abs(contribution) >= 0.05) factors.push({ id, contribution })
  }
  add('adm_grades', tier.slope * W.gpa * record.gpa)
  if (record.test === null) add('adm_no_test', -tier.slope * W.test * cfg.admissions.noTestPenalty)
  else add('adm_test', tier.slope * W.test * record.test)
  add('adm_rigor', tier.slope * W.rigor * record.rigor)
  // The same year is harder or easier for everyone applying to the same kind of college.
  add('adm_competition', -cfg.admissions.competitionSd * stable(state).normal('edu.competition', yearOf(state.now), tier.id))

  const base = logistic(-tier.slope * tier.bar)
  const logit = -tier.slope * tier.bar + factors.reduce((a, f) => a + f.contribution, 0)
  const probability = logistic(logit)
  const admitted = ctx.rng.chance(probability, 'edu.admission', person.id, tier.id)
  const outcome: OutcomeRecord = {
    id: newId(state, 'out'),
    month: state.now,
    kind: 'admission',
    subjectId: person.id,
    model: 'logit',
    base,
    baseSource: 'admissions model, content/countries/us/education/system.yaml',
    factors,
    probability,
    context: { tier: tier.id, admitted, label: tier.label },
  }
  const name = institutionName(ctx, person, tier)
  person.education.applications.push({ tier: tier.id, name, admitted, outcomeId: outcome.id })
  if (person.id === state.playerId) {
    state.outcomes[outcome.id] = outcome
    tell(ctx, person, 'admission', { which: admitted ? 'admitted' : 'denied', name, tier: tier.id, tierLabel: tier.label }, { significant: true, outcomeId: outcome.id })
  }
}

interface Price {
  netPrice: number
  parentsPay: number
  studentShare: number
}

/** What a year would cost this family, and who would pay (design §7.12, "Paying"). In start-year dollars. */
export function priceFor(ctx: Ctx, person: Person, tier: TierDef): Price {
  const cfg = cfgOf(ctx.content)
  // Aid is assessed on the parents' income wherever the student lives.
  const homes = new Map<string, number>()
  for (const parent of parentsOf(ctx.state, person)) {
    const home = householdOf(ctx.state, parent)
    if (home && !parent.died) homes.set(home.id, realIncome(ctx, home))
  }
  const own = householdOf(ctx.state, person)
  const income = homes.size ? [...homes.values()].reduce((a, b) => a + b, 0) : own ? realIncome(ctx, own) : 0
  let band = cfg.incomeBands.findIndex((upper) => income <= upper)
  if (band < 0) band = cfg.incomeBands.length
  const netPrice = tier.netPrice[band]!
  const P = cfg.paying.parents
  const willing = own?.collegeWillingness ?? 1
  const parentsPay = Math.min(netPrice, Math.round((Math.max(0, income - P.incomeFloor) * P.shareAboveFloor * willing) / 100) * 100)
  return { netPrice, parentsPay, studentShare: netPrice - parentsPay }
}

function offerCollegeChoice(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  const month = calendarMonth(ctx)
  const community = cfg.tiers.find((t) => t.open)
  const options: Array<{ id: string; label: string; cost?: { money: number } }> = []
  for (const application of person.education.applications) {
    if (!application.admitted) continue
    const tier = tierOf(cfg, application.tier)
    options.push({ id: tier.id, label: plainText(ctx, 'label.edu.enroll', person, { name: application.name, tierLabel: tier.label }), cost: { money: today(ctx, priceFor(ctx, person, tier).studentShare) } })
  }
  if (community) {
    const name = institutionName(ctx, person, community)
    options.push({ id: community.id, label: plainText(ctx, 'label.edu.enroll', person, { name, tierLabel: community.label }), cost: { money: today(ctx, priceFor(ctx, person, community).studentShare) } })
  }
  options.push({ id: 'none', label: plainText(ctx, 'label.edu.no_college', person) })
  openDecision(ctx, {
    source: 'system:edu.choose',
    subject: person,
    class: 'deferrable',
    deadlineMonths: Math.max(1, cfg.admissions.decideByMonth - month),
    promptId: 'prompt.edu.choose',
    promptData: { admitted: person.education.applications.filter((a) => a.admitted).length, applied: person.education.applications.length },
    options,
    optional: false,
    sourceClass: 'structural',
  })
}

registerSystemDecision('edu.choose', {
  resolve(ctx, _decision, subject, optionId, lapsed) {
    const cfg = cfgOf(ctx.content)
    if (optionId === 'none') {
      subject.education.plan = null
      tell(ctx, subject, 'college_declined', { lapsed }, { significant: true, source: 'player' })
      return
    }
    const tier = tierOf(cfg, optionId)
    const name = subject.education.applications.find((a) => a.tier === optionId)?.name ?? institutionName(ctx, subject, tier)
    subject.education.plan = { tier: tier.id, name }
    const price = priceFor(ctx, subject, tier)
    tell(ctx, subject, 'college_chosen', { which: tier.id, name, tierLabel: tier.label, netPrice: today(ctx, price.netPrice), parentsPay: today(ctx, price.parentsPay), yours: today(ctx, price.studentShare), lapsed }, { significant: true, source: 'player' })
  },
  weights(state, content, decision, subject) {
    const cfg = cfgOf(content)
    const ctx = reader(state, content)
    const E = cfg.choices.enroll
    const a = aspiration(ctx, subject)
    return decision.options.map((o) => {
      if (o.id === 'none') return dexp(E.none + E.noneAspiration * a)
      const tier = tierOf(cfg, o.id)
      const cost = E.costPer5000 * (priceFor(ctx, subject, tier).studentShare / 5000)
      return tier.open ? dexp(E.community + cost) : dexp(E.fourYear + E.prestige * tier.prestige + E.aspiration * a + cost)
    })
  },
})

/** March: colleges answer whoever applied in the autumn, and the applicant chooses. */
function admissionsRound(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  if (person.flags['edu.results'] === true) return
  const strategy = cfg.admissions.strategies.find((s) => s.id === person.flags['edu.strategy'])
  if (!strategy) return
  person.flags['edu.results'] = true
  if (strategy.id === 'none') return
  for (const id of strategy.tiers) decideApplication(ctx, person, tierOf(cfg, id))
  offerCollegeChoice(ctx, person)
}

/** Whether someone out of school could start, or go back to, college. */
function couldEnroll(person: Person): boolean {
  const edu = person.education
  return edu.status === 'out' && edu.plan === null && edu.program === null && (edu.level === 'high_school' || edu.level === 'some_college' || edu.level === 'associate')
}

function planCommunityCollege(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  const tier = cfg.tiers.find((t) => t.open)
  if (!tier) return
  const name = institutionName(ctx, person, tier)
  const price = priceFor(ctx, person, tier)
  person.education.plan = { tier: tier.id, name }
  tell(ctx, person, 'college_chosen', { which: tier.id, name, tierLabel: tier.label, netPrice: today(ctx, price.netPrice), parentsPay: today(ctx, price.parentsPay), yours: today(ctx, price.studentShare), lapsed: false }, { significant: true, source: 'player' })
}

/** Starts a fresh round of applications for someone who is no longer at school. */
function beginApplying(person: Person, strategy: string | null): void {
  person.education.applications = []
  person.flags['edu.results'] = null
  person.flags['edu.strategy'] = strategy
}

/** Yearly chance that someone with a diploma and no degree enrolls this autumn. Also for AI players. */
export function lateEntryChance(ctx: Ctx, person: Person): number {
  const L = cfgOf(ctx.content).college.lateEntry
  const age = ageYears(person, ctx.state.now)
  if (!couldEnroll(person) || person.education.level === 'associate' || age < L.fromAge || age >= L.untilAge || typeof person.flags['edu.strategy'] === 'string' && person.flags['edu.results'] !== true) return 0
  return logistic(L.base + L.aspiration * aspiration(ctx, person) + L.perYearAway * (age - L.fromAge))
}

registerAction('edu.enroll_community', {
  available(state, content, person) {
    if (!couldEnroll(person) || ageYears(person, state.now) < 17) return null
    const ctx = reader(state, content)
    const tier = cfgOf(content).tiers.find((t) => t.open)
    if (!tier) return null
    return { label: plainText(ctx, 'label.act.enroll_community', person, { name: institutionName(ctx, person, tier) }), section: 'school', costs: [`about $${today(ctx, priceFor(ctx, person, tier).studentShare).toLocaleString('en-US')} a year`] }
  },
  perform(ctx, person) {
    planCommunityCollege(ctx, person)
  },
})

registerAction('edu.apply', {
  available(state, content, person) {
    if (!couldEnroll(person) || ageYears(person, state.now) < 18) return null
    if (hasOpenDecision(state, 'system:edu.apply', person) || hasOpenDecision(state, 'system:edu.choose', person)) return null
    if (typeof person.flags['edu.strategy'] === 'string' && person.flags['edu.results'] !== true) return null
    return { label: plainText(reader(state, content), 'label.act.apply', person), section: 'school' }
  },
  perform(ctx, person) {
    beginApplying(person, null)
    offerApplications(ctx, person)
  },
})

// ---------------------------------------------------------------------------------------------
// College
// ---------------------------------------------------------------------------------------------

function cumulativeGpa(person: Person): number | null {
  const c = person.education.college
  return c && c.gradedCredits > 0 ? round2(c.gradePoints / c.gradedCredits) : null
}

/** Sets the year's price, what the parents give, the loan, and what is left uncovered. */
function billYear(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  const c = person.education.college
  if (!c) return
  const price = priceFor(ctx, person, tierOf(cfg, c.tier))
  const L = cfg.paying.loans
  const year = Math.floor(c.terms / 2)
  const gap = Math.max(0, price.studentShare - cfg.paying.ownEarnings)
  const offered = Math.max(0, Math.min(L.byYear[Math.min(year, L.byYear.length - 1)]!, L.aggregate - person.education.loans))
  // Someone who has already borrowed goes on borrowing while any need remains.
  const loan = gap > L.borrowIfGapAbove || (person.education.loans > 0 && gap > 0) ? offered : 0
  c.netPrice = price.netPrice
  c.parentsPay = price.parentsPay
  // A small gap is covered by a few more hours of work and does not count as unmet need.
  c.unmetNeed = loan === 0 && gap <= L.borrowIfGapAbove ? 0 : Math.max(0, gap - loan)
  // With real need left over, the student works more hours and studies fewer of them.
  c.partTime = c.unmetNeed > 4000
  person.education.loans += loan
  // The money moves: the loan goes straight to the college, and the parents pay their part.
  const { state } = ctx
  move(state, acct(person.id, 'student'), WORLD.colleges, today(ctx, loan))
  const parents = parentsOf(state, person).filter((p) => !p.died)
  const payers = [...new Set(parents.map((p) => unitHead(state, p).id))]
  for (const id of payers) payOut(ctx, state.people[id]!, today(ctx, price.parentsPay) / payers.length, WORLD.colleges)
  // With need still uncovered, some students sign for a private loan as well, at a higher rate.
  const P = ctx.content.bundle.country.money.studentLoans
  let privateLoan = 0
  if (c.unmetNeed > 2000 && stable(state).chance(P.privateShare, 'edu.private', person.id)) {
    privateLoan = Math.round(c.unmetNeed / 100) * 100
    person.education.loans += privateLoan
    move(state, acct(person.id, 'private'), WORLD.colleges, today(ctx, privateLoan))
  }
  // What neither parents nor loans cover comes out of the student's own pocket, from work if they have it.
  person.flags['edu.ownShare'] = Math.max(0, price.studentShare - loan - privateLoan)
  if (loan + privateLoan > 0) tell(ctx, person, 'loan_signed', { amount: today(ctx, loan + privateLoan), total: owed(ctx, person), year: year + 1, private: privateLoan > 0 }, { source: 'structural' })
}

function startCollege(ctx: Ctx, person: Person, credits = 0): void {
  const cfg = cfgOf(ctx.content)
  const plan = person.education.plan
  if (!plan) return
  const tier = tierOf(cfg, plan.tier)
  const transferring = credits > 0
  person.education.plan = null
  person.education.status = 'college'
  person.education.college = {
    tier: tier.id,
    name: plan.name,
    major: typeof person.flags['edu.major'] === 'string' && transferring ? (person.flags['edu.major'] as string) : 'general',
    started: ctx.state.now,
    partTime: false,
    credits,
    gradePoints: 0,
    gradedCredits: 0,
    terms: transferring ? 4 : 0,
    probation: false,
    netPrice: 0,
    parentsPay: 0,
    unmetNeed: 0,
  }
  billYear(ctx, person)
  const c = person.education.college
  tell(ctx, person, 'college_started', { which: transferring ? 'transfer' : tier.id, name: c.name, tierLabel: tier.label, netPrice: today(ctx, c.netPrice), parentsPay: today(ctx, c.parentsPay), unmet: today(ctx, c.unmetNeed), partTime: c.partTime }, { significant: true, source: 'player' })
  if (!transferring) {
    openDecision(ctx, {
      source: 'system:edu.major',
      subject: person,
      class: 'deferrable',
      deadlineMonths: 2,
      promptId: 'prompt.edu.major',
      promptData: { name: c.name },
      options: cfg.majors.filter((m) => (tier.open ? true : m.id !== 'general')).map((m) => ({ id: m.id, label: m.label })),
      optional: false,
      sourceClass: 'structural',
    })
  }
}

function majorWeights(content: Prepared, options: Decision['options'], subject: Person): number[] {
  const cfg = cfgOf(content)
  const tilt = (subject.aptitudes.quantitative ?? 0) - (subject.aptitudes.verbal ?? 0)
  return options.map((o) => {
    const major = cfg.majors.find((m) => m.id === o.id)
    if (!major) return 0
    // People lean toward what they are better at, and the well prepared toward harder fields.
    return dexp(1.2 * (major.math - 0.3) * tilt + 0.8 * major.difficulty * subject.education.standing)
  })
}

registerSystemDecision('edu.major', {
  resolve(ctx, _decision, subject, optionId, lapsed) {
    const c = subject.education.college
    if (!c) return
    c.major = optionId
    tell(ctx, subject, 'major_chosen', { which: optionId, label: cfgOf(ctx.content).majors.find((m) => m.id === optionId)?.label ?? optionId, lapsed, changed: false }, { source: 'player' })
  },
  weights: (_state, content, decision, subject) => majorWeights(content, decision.options, subject),
})

/** Per-term chance of leaving college without a degree, with the factors behind it. */
export function collegeLeaving(ctx: Ctx, person: Person): { probability: number; factors: OutcomeRecord['factors'] } {
  const cfg = cfgOf(ctx.content)
  const L = cfg.college.leaving
  const c = person.education.college
  if (!c) return { probability: 0, factors: [] }
  const tier = tierOf(cfg, c.tier)
  const factors: OutcomeRecord['factors'] = []
  const add = (id: string, contribution: number): void => {
    if (contribution !== 0) factors.push({ id, contribution })
  }
  add('col_low_grades', L.lowGpa * Math.max(0, 2.5 - (cumulativeGpa(person) ?? 2.5)))
  add('col_unmet_need', L.unmetNeedPer5000 * (c.unmetNeed / 5000))
  add('col_part_time', c.partTime ? L.partTime : 0)
  add('col_two_year', tier.open ? L.communityCollege : 0)
  add('col_conscientious', L.conscientiousness * (person.traits.conscientiousness ?? 0))
  add('col_first_generation', parentsOf(ctx.state, person).every((p) => educationRank(p.education.level) < educationRank('associate')) ? L.firstGeneration : 0)
  add('col_overtime', L.perTermBeyondNormal * Math.max(0, c.terms - tier.years * 2))
  return { probability: logistic(L.base + factors.reduce((a, f) => a + f.contribution, 0)), factors }
}

function leaveCollege(ctx: Ctx, person: Person, how: 'left' | 'dismissed' | 'finished'): void {
  const edu = person.education
  const c = edu.college
  if (!c) return
  if (how !== 'finished' && educationRank(edu.level) < educationRank('some_college')) edu.level = 'some_college'
  edu.status = 'out'
  person.flags['edu.major'] = c.major
  if (how !== 'finished') tell(ctx, person, 'college_left', { which: how, name: c.name, credits: Math.round(c.credits), loans: owed(ctx, person) }, { significant: true, source: 'player' })
  edu.college = null
  person.flags['edu.ownShare'] = 0
}

function offerTransfer(ctx: Ctx, person: Person, finished: boolean): void {
  const cfg = cfgOf(ctx.content)
  const gpa = cumulativeGpa(person) ?? 0
  const options: Array<{ id: string; label: string; cost?: { money: number } }> = []
  for (const id of cfg.college.transfer.tiers) {
    const tier = tierOf(cfg, id)
    // The college record stands in for the high-school one: a transfer applicant with a 3.3 is
    // about as likely to get in as a school-leaver at the bar.
    if ((gpa - 2.6) / 0.6 < tier.bar) continue
    options.push({ id: tier.id, label: plainText(ctx, 'label.edu.transfer', person, { name: institutionName(ctx, person, tier), tierLabel: tier.label }), cost: { money: today(ctx, priceFor(ctx, person, tier).studentShare) } })
  }
  if (options.length === 0) return
  options.push({ id: 'stay', label: plainText(ctx, finished ? 'label.edu.stop_here' : 'label.edu.stay_here', person) })
  person.flags['edu.transferOffered'] = true
  openDecision(ctx, {
    source: 'system:edu.transfer',
    subject: person,
    class: 'deferrable',
    deadlineMonths: 2,
    promptId: 'prompt.edu.transfer',
    promptData: { gpa, credits: Math.round(person.education.college?.credits ?? 0), finished },
    options,
    optional: false,
    sourceClass: 'structural',
  })
}

registerSystemDecision('edu.transfer', {
  resolve(ctx, _decision, subject, optionId) {
    const cfg = cfgOf(ctx.content)
    if (optionId === 'stay') return
    const tier = tierOf(cfg, optionId)
    const c = subject.education.college
    // Up to two years of credit move with the student; the new college starts in September.
    const credits = c ? Math.min(60, c.credits) : 60
    if (c) leaveCollege(ctx, subject, 'finished')
    const name = institutionName(ctx, subject, tier)
    subject.education.plan = { tier: tier.id, name }
    subject.flags['edu.transferCredits'] = credits
    tell(ctx, subject, 'transfer_planned', { which: tier.id, name, tierLabel: tier.label, credits: Math.round(credits) }, { significant: true, source: 'player' })
  },
  weights(state, content, decision, subject) {
    const cfg = cfgOf(content)
    const ctx = reader(state, content)
    const a = aspiration(ctx, subject)
    return decision.options.map((o) => {
      if (o.id === 'stay') return 1
      const tier = tierOf(cfg, o.id)
      return dexp(0.0 + 0.5 * a + 0.2 * tier.prestige + cfg.choices.enroll.costPer5000 * (priceFor(ctx, subject, tier).studentShare / 5000))
    })
  },
})

function awardDegree(ctx: Ctx, person: Person): void {
  const cfg = cfgOf(ctx.content)
  const c = person.education.college!
  const tier = tierOf(cfg, c.tier)
  const major = cfg.majors.find((m) => m.id === c.major)
  person.education.level = tier.credential
  person.flags['edu.major'] = c.major
  person.flags['edu.collegeGpa'] = cumulativeGpa(person)
  // Some degrees carry a license with them.
  const carried = tier.credential === 'bachelor' ? ctx.content.bundle.country.labor.degreeCredentials[c.major] : undefined
  if (carried && !person.credentials.includes(carried)) person.credentials.push(carried)
  tell(
    ctx,
    person,
    'degree_earned',
    { which: tier.credential, name: c.name, major: major?.label ?? '', gpa: cumulativeGpa(person), years: round2((ctx.state.now - c.started) / 12), loans: owed(ctx, person) },
    { significant: true, source: 'player' },
  )
}

function termEnd(ctx: Ctx, person: Person, term: 'fall' | 'spring'): void {
  const { state } = ctx
  const cfg = cfgOf(ctx.content)
  const c = person.education.college
  if (!c) return
  const tier = tierOf(cfg, c.tier)
  const major = cfg.majors.find((m) => m.id === c.major) ?? cfg.majors[0]!
  const G = cfg.college.grades

  // Preparation is where the student stood leaving school, tilted by how well the major suits them.
  const tilt = major.math * (person.aptitudes.quantitative ?? 0) + (1 - major.math) * (person.aptitudes.verbal ?? 0) - ((person.aptitudes.quantitative ?? 0) + (person.aptitudes.verbal ?? 0)) / 2
  const preparation = person.education.standing + 0.3 * tilt - tier.difficulty - major.difficulty
  const gpa = round2(clamp(G.mean + G.preparation * preparation + G.effort * effort(ctx, person) + G.unmetNeed * Math.min(2, c.unmetNeed / 5000) + G.noise * ctx.rng.normal('edu.term', person.id, state.now), 0, 4))
  const attempted = c.partTime ? cfg.college.partTimeCredits : cfg.college.creditsPerTerm
  const share = cfg.college.creditsEarned.find(([upTo]) => gpa < upTo)?.[1] ?? 1
  c.credits += attempted * share
  c.gradePoints += gpa * attempted
  c.gradedCredits += attempted
  c.terms += 1
  const cumulative = cumulativeGpa(person) ?? gpa
  tell(ctx, person, 'term_grades', { which: gpa >= 3.5 ? 'strong' : gpa >= 2.7 ? 'solid' : gpa >= 2.0 ? 'mixed' : 'poor', term, gpa, cumulative, credits: Math.round(c.credits), needed: cfg.college.creditsFor[tier.credential] }, { source: 'player' })

  if (c.credits >= cfg.college.creditsFor[tier.credential]) {
    awardDegree(ctx, person)
    // With an associate degree in hand, the question of going on for a bachelor's comes up.
    if (tier.credential === 'associate') offerTransfer(ctx, person, true)
    leaveCollege(ctx, person, 'finished')
    return
  }

  if (c.probation && cumulative < cfg.college.dismissalBelow && c.terms >= 2) {
    leaveCollege(ctx, person, 'dismissed')
    return
  }
  const wasOnProbation = c.probation
  c.probation = cumulative < cfg.college.probationBelow
  if (c.probation && !wasOnProbation) tell(ctx, person, 'probation', { cumulative }, { significant: true, source: 'player' })

  if (term === 'spring' && tier.open && !person.flags['edu.transferOffered'] && c.credits >= cfg.college.transfer.minCredits && cumulative >= cfg.college.transfer.minGpa) {
    offerTransfer(ctx, person, false)
    if (!person.education.college) return // transferred
  }

  // Everyone but the player decides here whether to carry on. The player decides for themselves.
  if (person.id !== state.playerId) {
    const leaving = collegeLeaving(ctx, person)
    if (ctx.rng.chance(leaving.probability, 'edu.leave', person.id, state.now)) leaveCollege(ctx, person, 'left')
  }
}

// ---------------------------------------------------------------------------------------------
// Leaving, and coming back for the equivalency
// ---------------------------------------------------------------------------------------------

registerSystemDecision('edu.leave', {
  resolve(ctx, _decision, subject, optionId, lapsed) {
    if (optionId === 'leave') leaveSchool(ctx, subject, 'dropped')
    else tell(ctx, subject, 'school_stayed', { lapsed }, { source: 'player' })
  },
  weights(state, content, _decision, subject) {
    // Over the coming year, as likely as the monthly chance makes it.
    const stay = dpow(1 - dropoutChance(state, content, subject), 12)
    return [stay, 1 - stay]
  },
})

registerAction('edu.leave_school', {
  available(state, content, person) {
    const edu = person.education
    const ctx = reader(state, content)
    if (edu.status === 'k12' && ageYears(person, state.now) >= cfgOf(content).k12.dropout.minAge) return { label: plainText(ctx, 'label.act.leave_school', person), section: 'school' }
    if (edu.status === 'college') return { label: plainText(ctx, 'label.act.leave_college', person, { name: edu.college?.name ?? '' }), section: 'school' }
    return null
  },
  perform(ctx, person) {
    if (person.education.status === 'k12') leaveSchool(ctx, person, 'dropped')
    else if (person.education.status === 'college') leaveCollege(ctx, person, 'left')
  },
})

registerAction('edu.change_major', {
  available(state, content, person) {
    const c = person.education.college
    if (!c) return null
    const cfg = cfgOf(content)
    const tier = tierOf(cfg, c.tier)
    return {
      label: plainText(reader(state, content), 'label.act.change_major', person),
      section: 'school',
      choices: cfg.majors.filter((m) => m.id !== c.major && (tier.open || m.id !== 'general')).map((m) => ({ id: m.id, label: m.label })),
    }
  },
  perform(ctx, person, choice) {
    const cfg = cfgOf(ctx.content)
    const c = person.education.college
    const major = cfg.majors.find((m) => m.id === choice)
    if (!c || !major || major.id === c.major) return
    // Some of what was taken for the old major does not count toward the new one.
    const lost = c.terms >= 2 ? Math.min(c.credits, cfg.college.changeMajorCredits) : 0
    c.credits -= lost
    c.major = major.id
    tell(ctx, person, 'major_chosen', { which: major.id, label: major.label, lapsed: false, changed: true, lost }, { source: 'player' })
  },
})

registerAction('edu.equivalency', {
  available(state, content, person) {
    if (person.education.status !== 'left_k12' || ageYears(person, state.now) < 17) return null
    for (const id in state.processes) if (state.processes[id]!.subjectId === person.id && state.processes[id]!.def === 'equivalency') return null
    return { label: plainText(reader(state, content), 'label.act.equivalency', person), section: 'school', costs: ['5 hours a week', 'four months'] }
  },
  perform(ctx, person) {
    startProcess(ctx, 'equivalency', person, 'player')
  },
})

/** Called when the `equivalency` process ends: the test itself. */
export function sitEquivalency(ctx: Ctx, person: Person): void {
  const { state } = ctx
  if (person.education.status !== 'left_k12') return
  // About seven in ten pass; where the person stood when they left school moves that either way.
  const base = 0.7
  const contribution = 0.9 * person.education.standing + 0.9
  const probability = logistic(logit(base) + contribution)
  const passed = ctx.rng.chance(probability, 'edu.equivalency', person.id, state.now)
  const outcome: OutcomeRecord = {
    id: newId(state, 'out'),
    month: state.now,
    kind: 'equivalency',
    subjectId: person.id,
    model: 'logit',
    base,
    baseSource: 'GED Testing Service pass rates (memory)',
    factors: Math.abs(contribution) >= 0.05 ? [{ id: 'eq_standing', contribution }] : [],
    probability,
    context: { passed },
  }
  if (person.id === state.playerId) state.outcomes[outcome.id] = outcome
  if (passed) {
    person.education.status = 'out'
    person.education.level = 'high_school'
  }
  tell(ctx, person, 'equivalency', { which: passed ? 'passed' : 'failed' }, { significant: true, source: 'player', ...(person.id === state.playerId ? { outcomeId: outcome.id } : {}) })
}

// ---------------------------------------------------------------------------------------------
// The month
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Certificates and graduate school
// ---------------------------------------------------------------------------------------------

type Program = Prepared['bundle']['country']['labor']['programs'][number]

function programsOpenTo(content: Prepared, person: Person): Program[] {
  const edu = person.education
  if (edu.status !== 'out' || edu.program !== null || edu.plan !== null) return []
  return content.bundle.country.labor.programs.filter(
    (p) => educationRank(edu.level) >= educationRank(p.needs) && !person.credentials.includes(p.credential) && (!p.majors || p.majors.includes(String(person.flags['edu.major'] ?? ''))) && !(p.kind === 'graduate' && edu.level === 'graduate'),
  )
}

/** Applies to a program. Certificates take anyone with the schooling; graduate programs judge the college record. */
function enterProgram(ctx: Ctx, person: Person, program: Program): void {
  const { state } = ctx
  if (program.kind === 'graduate' && program.bar !== undefined) {
    const gpa = typeof person.flags['edu.collegeGpa'] === 'number' ? (person.flags['edu.collegeGpa'] as number) : 3.0
    const contribution = 3.2 * (gpa - program.bar)
    const probability = logistic(contribution)
    const admitted = ctx.rng.chance(probability, 'edu.program', person.id, program.id, state.now)
    const outcome: OutcomeRecord = {
      id: newId(state, 'out'),
      month: state.now,
      kind: 'program_admission',
      subjectId: person.id,
      model: 'logit',
      base: 0.5,
      baseSource: program.source,
      factors: Math.abs(contribution) >= 0.05 ? [{ id: 'adm_college_record', contribution }] : [],
      probability,
      context: { label: program.label, admitted },
    }
    if (person.id === state.playerId) state.outcomes[outcome.id] = outcome
    if (!admitted) {
      tell(ctx, person, 'program_denied', { label: program.label }, { significant: true, source: 'player', ...(person.id === state.playerId ? { outcomeId: outcome.id } : {}) })
      return
    }
  }
  person.education.program = { id: program.id, started: state.now, ends: state.now + program.months }
  tell(ctx, person, 'program_started', { label: program.label, which: program.kind, months: program.months, cost: today(ctx, program.cost) }, { significant: true, source: 'player' })
}

function programMonth(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  const L = content.bundle.country.labor
  const edu = person.education
  const current = edu.program
  if (current) {
    const program = L.programs.find((p) => p.id === current.id)
    if (!program) {
      edu.program = null
      return
    }
    // Tuition is borrowed as it falls due.
    if (program.cost > 0) {
      edu.loans += program.cost / 12
      move(state, acct(person.id, 'student'), WORLD.colleges, (program.cost * state.world.priceLevel) / 12)
    }
    if (state.now < current.ends) return
    edu.program = null
    const passed = ctx.rng.chance(program.completes, 'edu.program.finish', person.id, program.id)
    if (passed) {
      person.credentials.push(program.credential)
      if (program.kind === 'graduate') edu.level = 'graduate'
    }
    tell(ctx, person, 'program_finished', { which: passed ? 'completed' : 'failed', label: program.label, kind: program.kind, loans: owed(ctx, person) }, { significant: true, source: 'player' })
    return
  }
  // Other people decide each August whether to start one; the player uses the action.
  if (person.id === state.playerId || calendarMonth(ctx) !== 8) return
  const chance = programChance(state, content, person)
  if (!ctx.rng.chance(chance.certificate + chance.graduate, 'edu.program.enter', person.id, state.now)) return
  const program = pickProgram(ctx, person, ctx.rng.chance(chance.graduate / Math.max(1e-9, chance.certificate + chance.graduate), 'edu.program.kind', person.id, state.now) ? 'graduate' : 'certificate')
  if (program) enterProgram(ctx, person, program)
}

function pickProgram(ctx: Ctx, person: Person, kind: Program['kind']): Program | null {
  const open = programsOpenTo(ctx.content, person).filter((p) => p.kind === kind)
  const index = ctx.rng.weighted(open.map((p) => p.weight), 'edu.program.pick', person.id, ctx.state.now)
  return index < 0 ? null : open[index]!
}

/** Yearly chance that someone who could start a certificate or a graduate program does. Also for AI players. */
export function programChance(state: GameState, content: Prepared, person: Person): { certificate: number; graduate: number } {
  const E = content.bundle.country.labor.programEntry
  const age = ageYears(person, state.now)
  const open = programsOpenTo(content, person)
  if (age < 18 || age >= E.untilAge || open.length === 0) return { certificate: 0, graduate: 0 }
  const degree = educationRank(person.education.level) >= educationRank('bachelor')
  return {
    // Certificates draw people without a degree; a graduate program, those whose record would get them in.
    certificate: open.some((p) => p.kind === 'certificate') && (!degree || open.some((p) => p.id === 'teaching')) ? E.certificatePerYear * (degree ? 0.4 : 1) : 0,
    graduate: open.some((p) => p.kind === 'graduate') ? E.graduatePerYear * dexp(0.6 * ((typeof person.flags['edu.collegeGpa'] === 'number' ? (person.flags['edu.collegeGpa'] as number) : 3) - 3.2)) : 0,
  }
}

registerAction('edu.program', {
  available(state, content, person) {
    const open = programsOpenTo(content, person)
    if (open.length === 0 || ageYears(person, state.now) < 17) return null
    const ctx = reader(state, content)
    return {
      label: plainText(ctx, 'label.act.program', person),
      section: 'school',
      costs: ['tuition is borrowed'],
      choices: open.map((p) => ({ id: p.id, label: plainText(ctx, 'label.edu.program_option', person, { label: p.label, months: p.months, cost: today(ctx, p.cost), which: p.kind }) })),
    }
  },
  perform(ctx, person, choice) {
    const program = programsOpenTo(ctx.content, person).find((p) => p.id === choice)
    if (program) enterProgram(ctx, person, program)
  },
})

/** One month of schooling for one person, whatever stage they are at. */
export function educationMonth(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  const cfg = cfgOf(content)
  const edu = person.education
  if (edu.status === 'not_modeled') return
  const month = calendarMonth(ctx)
  const age = ageYears(person, state.now)
  strainMonth(ctx, person)

  if (edu.status === 'not_yet') {
    if (month === 9 && age >= cfg.k12.entryAge) enroll(ctx, person)
    return
  }

  if (edu.status === 'k12') {
    const inSession = cfg.k12.schoolMonths.includes(month)
    if (month === 9 && edu.lastReport && edu.lastReport.grade === edu.grade) {
      // A new school year.
      const grade = (edu.grade ?? 0) + 1
      const before = edu.school?.name
      edu.grade = grade
      edu.school = schoolFor(ctx, person, grade)
      if (edu.school.name !== before) tell(ctx, person, 'school_moved_up', { which: grade <= 8 ? 'middle' : 'high', school: edu.school.name, gradeName: GRADE_NAMES[grade] ?? '' }, { significant: true })
      if (grade >= 9) offerCourseLevel(ctx, person, grade)
    }
    learn(ctx, person, inSession)
    disengagementMonth(ctx, person)

    const grade = edu.grade ?? 0
    if (grade === cfg.test.grade && month === cfg.test.month && !edu.test && !hasOpenDecision(state, 'system:edu.test', person)) offerTest(ctx, person)
    if (grade === 12 && month === cfg.admissions.applyMonth && person.flags['edu.strategy'] === undefined) offerApplications(ctx, person)
    if (grade === 12 && month === cfg.admissions.month) admissionsRound(ctx, person)
    if (month === 6) {
      reportCard(ctx, person)
      if (grade === 12) {
        graduateOrNot(ctx, person)
        return
      }
    }

    // Old enough to leave: other people act on the chance; the player is asked, at most once a year.
    const chance = dropoutChance(state, content, person)
    if (chance > 0) {
      if (person.id !== state.playerId) {
        if (ctx.rng.chance(chance, 'edu.dropout', person.id, state.now)) leaveSchool(ctx, person, 'dropped')
      } else if (edu.disengagement > cfg.k12.dropout.promptAbove && month === 2 && !hasOpenDecision(state, 'system:edu.leave', person)) {
        openDecision(ctx, {
          source: 'system:edu.leave',
          subject: person,
          class: 'deferrable',
          deadlineMonths: 2,
          promptId: 'prompt.edu.leave',
          promptData: { gpa: edu.lastReport?.gpa ?? null, gradeName: GRADE_NAMES[grade] ?? '' },
          options: [
            { id: 'stay', label: plainText(ctx, 'label.edu.stay_in_school', person) },
            { id: 'leave', label: plainText(ctx, 'label.edu.leave_school', person) },
          ],
          optional: false,
          sourceClass: 'player',
        })
      }
    }
    return
  }

  if (edu.status === 'left_k12') {
    // Other people come back for the equivalency on their own; the player has to choose to.
    const eq = cfg.k12.equivalency
    if (person.id !== state.playerId && age >= 17 && age < eq.untilAge && ctx.rng.chance(eq.perMonth, 'edu.ged', person.id, state.now)) {
      edu.status = 'out'
      edu.level = 'high_school'
    }
    return
  }

  if (edu.status === 'out') {
    programMonth(ctx, person)
    if (month === cfg.admissions.month) admissionsRound(ctx, person)
    // Other people decide each August whether this is the year they go; the player uses the
    // actions above.
    if (month === 8 && person.id !== state.playerId) {
      const L = cfg.college.lateEntry
      if (ctx.rng.chance(lateEntryChance(ctx, person), 'edu.late', person.id, state.now)) {
        if (ctx.rng.chance(L.communityShare, 'edu.lateWhere', person.id, state.now)) planCommunityCollege(ctx, person)
        else beginApplying(person, L.applyStrategy)
      }
    }
    if (month === 9 && edu.plan) {
      const credits = typeof person.flags['edu.transferCredits'] === 'number' ? (person.flags['edu.transferCredits'] as number) : 0
      person.flags['edu.transferCredits'] = null
      startCollege(ctx, person, credits)
    }
    return
  }

  if (edu.status === 'college') {
    if (month === 9 && edu.college && edu.college.started !== state.now) billYear(ctx, person)
    if (month === 12) termEnd(ctx, person, 'fall')
    else if (month === 5) termEnd(ctx, person, 'spring')
  }
}

/**
 * Gives an older sibling, who enters the simulation part-way through school, the record they
 * would plausibly have by now: the same learning model, without the year-to-year luck.
 */
export function backfillSchooling(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  const cfg = cfgOf(content)
  const month = calendarMonth(ctx)
  // Septembers since the one in which they were old enough to start.
  const monthsSinceSeptember = (month - 9 + 12) % 12
  const lastSeptember = state.now - monthsSinceSeptember
  const ageAtLastSeptember = Math.floor((lastSeptember - person.born) / 12)
  if (ageAtLastSeptember < cfg.k12.entryAge) return
  if (ageAtLastSeptember - cfg.k12.entryAge > 12) {
    // Already past school age: assumed to have finished high school.
    person.education.status = 'out'
    person.education.level = 'high_school'
    return
  }
  const grade = ageAtLastSeptember - cfg.k12.entryAge
  const home = homeSupport(ctx, person)
  const edu = person.education
  edu.status = 'k12'
  edu.grade = grade
  edu.school = schoolFor(ctx, person, grade)

  let zSum = 0
  for (const subject of cfg.k12.subjects) {
    const start = cfg.k12.readiness.sd * readinessZ(ctx, person, subject.aptitude, home)
    const perYear = dexp(logLearningRate(ctx, person, subject.aptitude, subject.id, grade, false)) + cfg.k12.summer.base + cfg.k12.summer.home * home
    const thisYear = cfg.k12.schoolMonths.includes(month) ? Math.min(cfg.k12.schoolMonths.length, monthsSinceSeptember) / cfg.k12.schoolMonths.length : 1
    person.skills[subject.id] = start + perYear * grade + dexp(logLearningRate(ctx, person, subject.aptitude, subject.id, grade, false)) * thisYear
    if (grade > 0) {
      const n = norm(content, subject.id, grade - 1)
      zSum += (start + perYear * grade - n.mean) / n.sd
    } else {
      zSum += start / cfg.k12.readiness.sd
    }
  }
  edu.standing = zSum / cfg.k12.subjects.length
  if (grade > 0) {
    const G = cfg.k12.grades
    const gpa = round2(clamp(G.mean + G.achievement * edu.standing + G.effort * effort(ctx, person), 0, 4))
    edu.lastReport = { grade: grade - 1, points: Object.fromEntries(cfg.k12.subjects.map((s) => [s.id, gpa])), gpa, skills: { ...person.skills } }
    const hsYears = Math.max(0, grade - 9)
    edu.hs = { gpaSum: gpa * hsYears, years: hsYears, rigorSum: 0 }
  }
}

/**
 * How likely this person is, over the coming year, to leave school or college of their own
 * accord. Other people act on these chances month by month and term by term; AI players, who
 * act once a year, use this so that they behave as other people do.
 */
export function leavingChances(state: GameState, content: Prepared, person: Person): { school: number; college: number; equivalency: number; enroll: number; enrollAtCommunity: number; certificate: number; graduate: number } {
  const school = 1 - dpow(1 - dropoutChance(state, content, person), 12)
  const college = person.education.college ? 1 - dpow(1 - collegeLeaving(reader(state, content), person).probability, 2) : 0
  const eq = cfgOf(content).k12.equivalency
  const age = ageYears(person, state.now)
  const programs = programChance(state, content, person)
  const equivalency = person.education.status === 'left_k12' && age >= 17 && age < eq.untilAge ? 1 - dpow(1 - eq.perMonth, 12) : 0
  return { school, college, equivalency, enroll: lateEntryChance(reader(state, content), person), enrollAtCommunity: cfgOf(content).college.lateEntry.communityShare, certificate: programs.certificate, graduate: programs.graduate }
}

export function gradeName(grade: number): string {
  return GRADE_NAMES[grade] ?? ''
}

registerHook('edu.sit_equivalency', sitEquivalency)
