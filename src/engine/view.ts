/**
 * The perceived world (design §3.5, §11). The interface receives a PlayerView and nothing else:
 * hidden numbers leave the engine only as words, as observed behavior, or as the kind of record a
 * real person would hold (a report card, a test score, a bill). Imperfect information is enforced
 * here, at the boundary.
 */

import { ageInYears, monthName, yearOf } from './core/time'
import type { Prepared } from './content/prepare'
import { gradeName, hsGpa, letterGrade } from './country/us/education'
import { ageYears, parentsOf, relationOf, siblingsOf } from './people'
import { player, type Cost, type GameState, type Person } from './state'
import { availableActions } from './systems/actions'
import { describe } from './systems/perception'

export interface FeedItem {
  id: string
  kind: string
  dateText: string
  age: number
  text: string
  significant: boolean
  /** Present when the player can ask why this happened. */
  whyId?: string
  /** Present while this entry is a decision still waiting for an answer. */
  decisionId?: string
}

export interface DecisionView {
  id: string
  blocking: boolean
  prompt: string
  /** e.g. "Decide by the end of March 2061", or empty for blocking decisions. */
  dueText: string
  options: Array<{ id: string; label: string; costs: string[] }>
}

export interface PolicyView {
  current: string
  canChange: boolean
  lockedReason: string
  options: Array<{ id: string; label: string; description: string; hoursPerWeek: number }>
}

export interface FamilyMember {
  id: string
  name: string
  /** "mother", "brother"… */
  relation: string
  /** "34", or "died in 2051 at 71". */
  age: string
  /** What the character knows of them now, in a few words. */
  notes: string[]
}

export interface SchoolView {
  /** One line: "Fourth grade at Oakdale Elementary". Empty when not enrolled. */
  line: string
  /** Highest level completed, in words. */
  attained: string
  reportCard: { title: string; gpa: string; subjects: Array<{ label: string; letter: string }> } | null
  /** Records a person would hold: exact, because the school hands them over. */
  facts: Array<{ label: string; value: string }>
}

export interface ActionView {
  id: string
  label: string
  section: string
  costs: string[]
  choices: Array<{ id: string; label: string }>
}

export interface PlayerView {
  phase: 'alive' | 'ended'
  seed: string
  date: { month: string; year: number }
  place: string
  person: { name: string; firstName: string; sex: 'male' | 'female'; age: number; ageText: string; stageLabel: string }
  status: { health: string; conditions: string[]; fitness: string; strength: string; strain: string }
  feed: FeedItem[]
  decisions: DecisionView[]
  routine: { activity: PolicyView; study: PolicyView | null }
  family: { money: string; members: FamilyMember[] }
  school: SchoolView
  actions: ActionView[]
  advance: { allowed: boolean; blockedReason: string }
  death: { age: number; dateText: string } | null
}

function ageText(months: number): string {
  if (months < 1) return 'newborn'
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} old`
  return `${Math.floor(months / 12)} years old`
}

function dollars(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
}

function costText(cost: Cost | undefined, currency: string): string[] {
  if (!cost) return []
  const out: string[] = []
  if (cost.hoursPerWeek) out.push(`${cost.hoursPerWeek} hour${cost.hoursPerWeek === 1 ? '' : 's'} a week`)
  if (cost.money !== undefined) out.push(cost.money === 0 ? 'no cost to you' : dollars(cost.money, currency))
  if (cost.energy && cost.energy !== 'none') out.push(cost.energy === 'low' ? 'takes a little energy' : cost.energy === 'moderate' ? 'takes some energy' : 'takes a lot of energy')
  return out
}

const ATTAINED: Record<string, string> = {
  less_than_hs: 'No diploma',
  high_school: 'High school diploma',
  some_college: 'Some college, no degree',
  associate: 'Associate degree',
  bachelor: "Bachelor's degree",
  graduate: 'Graduate degree',
}

/** What the character knows of a relative: where they are and what they are doing. */
function memberNotes(state: GameState, content: Prepared, self: Person, other: Person): string[] {
  if (other.died) return []
  const notes: string[] = []
  const age = ageYears(other, state.now)
  notes.push(other.householdId !== null && other.householdId === self.householdId ? 'lives with you' : 'lives elsewhere')
  const edu = other.education
  if (edu.status === 'k12' && edu.grade !== null) notes.push(`in ${gradeName(edu.grade)}`)
  else if (edu.status === 'college' && edu.college) notes.push(`at ${edu.college.name}`)
  else if (age >= 18 && other.work) {
    const retired = age >= content.bundle.country.earnings.retirement.age
    notes.push(retired ? 'retired' : other.work.hours === 'none' ? 'at home' : other.work.employed ? (other.work.hours === 'part' ? 'working part-time' : 'working') : 'out of work')
  }
  return notes
}

function familyView(state: GameState, content: Prepared, self: Person): PlayerView['family'] {
  const members: FamilyMember[] = []
  for (const other of [...parentsOf(state, self), ...siblingsOf(state, self)]) {
    const at = other.died?.at ?? state.now
    const age = ageInYears(other.born, at)
    members.push({
      id: other.id,
      name: `${other.name.first} ${other.name.family}`,
      relation: relationOf(self, other),
      age: other.died ? `died in ${yearOf(other.died.at)} at ${age}` : age < 1 ? 'a baby' : String(age),
      notes: memberNotes(state, content, self, other),
    })
  }
  // Money at home in the words a member of the household would use, not a figure.
  const home = self.householdId ? state.households[self.householdId] : undefined
  const poverty = content.bundle.country.family.poverty
  const ratio = home ? home.income / (poverty.base + poverty.perAdditional * Math.max(0, home.members.length - 1)) : 0
  const money = ratio < 1 ? 'There is not enough money at home.' : ratio < 2 ? 'Money is tight at home.' : ratio < 4 ? 'The household gets by.' : ratio < 7 ? 'The household is comfortable.' : 'The household is well off.'
  return { money, members }
}

function schoolView(state: GameState, content: Prepared, self: Person): SchoolView {
  const cfg = content.bundle.country.education
  const currency = content.bundle.country.currency
  const edu = self.education
  const facts: SchoolView['facts'] = []
  let line = ''
  if (edu.status === 'k12' && edu.grade !== null && edu.school) {
    const name = gradeName(edu.grade)
    line = `${name[0]!.toUpperCase()}${name.slice(1)} at ${edu.school.name}`
    if (edu.grade >= 9) facts.push({ label: 'Courses', value: cfg.k12.courseLevels.find((c) => c.id === edu.courseLevel)?.label ?? '' })
  } else if (edu.status === 'college' && edu.college) {
    const c = edu.college
    const tier = cfg.tiers.find((t) => t.id === c.tier)
    line = `${c.name}${c.partTime ? ', part-time' : ''}`
    facts.push({ label: 'Major', value: cfg.majors.find((m) => m.id === c.major)?.label ?? '' })
    facts.push({ label: 'Credits', value: `${Math.round(c.credits)} of ${tier ? cfg.college.creditsFor[tier.credential] : ''}` })
    if (c.gradedCredits > 0) facts.push({ label: 'College GPA', value: (c.gradePoints / c.gradedCredits).toFixed(2) + (c.probation ? ' (on probation)' : '') })
    facts.push({ label: 'Cost this year', value: dollars(c.netPrice, currency) })
    facts.push({ label: 'Your parents pay', value: dollars(c.parentsPay, currency) })
    if (c.unmetNeed > 0) facts.push({ label: 'Still uncovered', value: dollars(c.unmetNeed, currency) })
  } else if (edu.plan) {
    line = `Starting at ${edu.plan.name} in September`
  }
  const gpa = hsGpa(self)
  if (gpa !== null) facts.push({ label: 'High school GPA', value: gpa.toFixed(2) })
  if (edu.test) facts.push({ label: cfg.test.name, value: `${edu.test.verbal + edu.test.math} (${edu.test.verbal} reading and writing, ${edu.test.math} math)` })
  if (edu.loans > 0) facts.push({ label: 'Student loans', value: dollars(edu.loans, currency) })

  const report = edu.lastReport
  return {
    line,
    attained: edu.status === 'not_modeled' ? '' : (ATTAINED[edu.level] ?? ''),
    reportCard:
      report && edu.status === 'k12'
        ? {
            title: `Last report card, ${gradeName(report.grade)}`,
            gpa: report.gpa.toFixed(2),
            subjects: cfg.k12.subjects.map((s) => ({ label: s.label, letter: letterGrade(report.points[s.id] ?? 0) })),
          }
        : null,
    facts,
  }
}

export function perceive(state: GameState, content: Prepared): PlayerView {
  const self = player(state)
  const at = self.died?.at ?? state.now
  const months = at - self.born
  const age = ageInYears(self.born, at)
  const body = content.bundle.body
  const study = content.bundle.country.education.k12.study
  const currency = content.bundle.country.currency
  const stage = content.bundle.stages.find((s) => s.id === content.stageFor(age))
  const alive = state.phase === 'alive'

  const openById = new Map(state.decisions.filter((d) => d.subjectId === self.id).map((d) => [d.id, d]))
  const feed: FeedItem[] = []
  for (const entry of state.log) {
    if (entry.hidden || !entry.text) continue
    const decisionId = entry.fact.kind === 'decision_opened' ? String(entry.fact.data.decision) : undefined
    feed.push({
      id: entry.id,
      kind: entry.fact.kind,
      dateText: `${monthName(entry.month)} ${yearOf(entry.month)}`,
      age: entry.age,
      text: entry.text,
      significant: entry.fact.significant,
      ...(entry.fact.outcomeId ? { whyId: entry.fact.outcomeId } : {}),
      ...(decisionId && openById.has(decisionId) ? { decisionId } : {}),
    })
  }

  const decisions: DecisionView[] = [...openById.values()].map((d) => ({
    id: d.id,
    blocking: d.class === 'blocking',
    prompt: d.prompt,
    dueText: d.deadline === null ? '' : `Decide by the end of ${monthName(d.deadline)} ${yearOf(d.deadline)}`,
    options: d.options.map((o) => ({ id: o.id, label: o.label, costs: costText(o.cost, currency) })),
  }))

  const conditions: string[] = []
  for (const id of Object.keys(state.processes).sort()) {
    const inst = state.processes[id]!
    if (inst.subjectId !== self.id) continue
    const status = content.processes.get(inst.def)?.stageById.get(inst.stage)?.status
    if (status) conditions.push(status)
  }

  const blocking = decisions.find((d) => d.blocking)
  const canMove = age >= body.activityChoiceFromAge && alive
  const enrolled = self.education.status === 'k12' || self.education.status === 'college'
  const canStudy = age >= study.choiceFromAge && alive

  return {
    phase: state.phase,
    seed: state.meta.seed,
    date: { month: monthName(at), year: yearOf(at) },
    place: content.bundle.country.states.find((s) => s.id === (self.householdId ? state.households[self.householdId]?.state : undefined))?.name ?? content.bundle.country.name,
    person: { name: `${self.name.first} ${self.name.family}`, firstName: self.name.first, sex: self.sex, age, ageText: ageText(months), stageLabel: stage?.label ?? '' },
    status: {
      health: conditions[0] ?? describe(state, content, self, 'stamina'),
      conditions,
      fitness: describe(state, content, self, 'fitness'),
      strength: describe(state, content, self, 'strength'),
      strain: describe(state, content, self, 'strain'),
    },
    feed,
    decisions,
    routine: {
      activity: {
        current: self.policies.activity,
        canChange: canMove,
        lockedReason: canMove || !alive ? '' : `You are too young to set your own routine. That changes at ${body.activityChoiceFromAge}.`,
        options: body.activityLevels.map((a) => ({ id: a.id, label: a.label, description: a.description, hoursPerWeek: a.hoursPerWeek })),
      },
      study: enrolled
        ? {
            current: self.policies.study,
            canChange: canStudy,
            lockedReason: canStudy || !alive ? '' : `For now your parents and your teacher decide how much work you do. From ${study.choiceFromAge} it is up to you.`,
            options: study.levels.map((l) => ({ id: l.id, label: l.label, description: l.description, hoursPerWeek: l.hoursPerWeek })),
          }
        : null,
    },
    family: familyView(state, content, self),
    school: schoolView(state, content, self),
    actions: alive ? availableActions(state, content, self).map((a) => ({ id: a.id, label: a.label, section: a.section, costs: a.costs ?? [], choices: a.choices ?? [] })) : [],
    advance: {
      allowed: alive && !blocking,
      blockedReason: !alive ? 'This life has ended.' : blocking ? 'Something needs your answer first.' : '',
    },
    death: self.died ? { age, dateText: `${monthName(self.died.at)} ${yearOf(self.died.at)}` } : null,
  }
}
