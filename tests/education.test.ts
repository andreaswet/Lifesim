import { describe, expect, it } from 'vitest'
import { EngineError, checkInvariants, perceive, step, type GameState } from '../src/engine'
import { explainOutcome } from '../src/narrative'
import { runBatch, summarize } from '../src/tools/batch-lib'
import { playYear } from '../src/tools/players'
import { liveUntil, newLife, realContent, testEnv } from './helpers'

const content = realContent()
const env = testEnv(content, true)
const cfg = content.bundle.country.education
const self = (s: GameState) => s.people.p1!
const kinds = (s: GameState, kind: string) => s.log.filter((e) => e.fact.kind === kind)
const ageOf = (s: GameState): number => Math.floor((s.now - self(s).born) / 12)
const until = (age: number) => (s: GameState) => ageOf(s) >= age

/** Plays a strategy until an age or the end of the life. */
function play(seed: string, strategy: Parameters<typeof playYear>[1], age: number): GameState {
  let s = newLife(seed, env, 200)
  while (s.phase === 'alive' && ageOf(s) < age) s = playYear(s, strategy, env)
  return s
}

function findStriver(prefix: string, age: number, test: (s: GameState) => boolean, tries = 120): GameState {
  for (let i = 0; i < tries; i++) {
    const s = play(`${prefix}-${i}`, 'striver', age)
    if (test(s)) return s
  }
  throw new Error(`no life found for ${prefix}`)
}

describe('school', () => {
  const s = liveUntil(newLife('school-1', env, 200), env, until(15))

  it('starts in the September after turning five and moves up a grade every year', () => {
    const start = kinds(s, 'school_started')[0]!
    expect(start.month % 12).toBe(8)
    expect(start.age).toBe(5)
    const reports = kinds(s, 'report_card')
    expect(reports.map((e) => e.fact.data.grade)).toEqual(reports.map((_, i) => i))
    expect(reports.every((e) => e.month % 12 === 5)).toBe(true)
    // New buildings at sixth and ninth grade.
    expect(kinds(s, 'school_moved_up').map((e) => e.fact.data.which)).toEqual(['middle', 'high'])
  })

  it('hands over a report card with real grades, and nothing else about ability', () => {
    const view = perceive(s, content)
    expect(view.school.line).toMatch(/^(Ninth|Tenth) grade at .+ High School$/)
    expect(view.school.reportCard!.subjects.map((x) => x.label)).toEqual(['reading and writing', 'math'])
    for (const subject of view.school.reportCard!.subjects) expect(subject.letter).toMatch(/^[A-DF][+-]?$/)
    expect(Number(view.school.reportCard!.gpa)).toBeGreaterThanOrEqual(0)
    expect(Number(view.school.reportCard!.gpa)).toBeLessThanOrEqual(4)
    const json = JSON.stringify(view)
    for (const hidden of ['aptitudes', 'genes', 'traits', 'standing', 'disengagement', '"skills"']) expect(json).not.toContain(hidden)
    expect(json).not.toContain(String(self(s).skills.math))
  })

  it('leaves the amount of schoolwork to the parents until eight, then to the pupil', () => {
    const young = liveUntil(newLife('school-2', env, 200), env, until(7))
    expect(perceive(young, content).routine.study!.canChange).toBe(false)
    expect(() => step(young, { type: 'setPolicy', policy: { study: 'pushing' } }, env)).toThrow(EngineError)
    const older = liveUntil(young, env, until(8))
    const changed = step(older, { type: 'setPolicy', policy: { study: 'pushing' } }, env)
    expect(changed.facts.map((f) => f.kind)).toEqual(['study_changed'])
    expect(() => step(older, { type: 'setPolicy', policy: { study: 'cramming' } }, env)).toThrow(EngineError)
  })

  it('effort pays, slowly: the same child working hard ends up measurably ahead', () => {
    // A paired counterfactual: one seed, two levels of effort from eight to fifteen.
    const base = liveUntil(newLife('school-3', env, 200), env, until(8))
    const lifeWith = (study: string): GameState => liveUntil(step(base, { type: 'setPolicy', policy: { study } }, env).state, env, until(15))
    const hard = lifeWith('pushing')
    const slack = lifeWith('minimal')
    for (const subject of ['literacy', 'math']) {
      const gain = self(hard).skills[subject]! - self(slack).skills[subject]!
      expect(gain).toBeGreaterThan(0.3) // grade equivalents after seven years
      expect(gain).toBeLessThan(3)
    }
    expect(self(hard).education.lastReport!.gpa).toBeGreaterThan(self(slack).education.lastReport!.gpa)
    // One year of it changes little.
    const oneYear = liveUntil(step(base, { type: 'setPolicy', policy: { study: 'pushing' } }, env).state, env, until(9))
    const oneYearSlack = liveUntil(step(base, { type: 'setPolicy', policy: { study: 'minimal' } }, env).state, env, until(9))
    expect(self(oneYear).skills.math! - self(oneYearSlack).skills.math!).toBeLessThan(0.45)
  })

  it('there are only so many hours: schoolwork and training together cost something', () => {
    const base = liveUntil(newLife('school-4', env, 200), env, until(10))
    const both = liveUntil(step(base, { type: 'setPolicy', policy: { study: 'pushing', activity: 'active' } }, env).state, env, until(12))
    const neither = liveUntil(step(base, { type: 'setPolicy', policy: { study: 'steady', activity: 'light' } }, env).state, env, until(12))
    expect(self(both).strain).toBeGreaterThan(0.3)
    expect(self(neither).strain).toBeLessThan(0.05)
    expect(perceive(both, content).status.strain).not.toBe(perceive(neither, content).status.strain)
    expect(kinds(both, 'band_changed').some((e) => e.fact.data.descriptor === 'strain' && e.fact.data.direction === 'up')).toBe(true)
  })

  it('brothers and sisters go through school too', () => {
    const family = liveUntil(newLife('school-5', env, 200), env, until(22))
    const siblings = Object.values(family.people).filter((p) => p.motherId === self(family).motherId && p.id !== 'p1' && !p.died && (family.now - p.born) / 12 >= 22)
    for (const sibling of siblings) {
      expect(['left_k12', 'out', 'college']).toContain(sibling.education.status)
      if (sibling.education.status !== 'left_k12') expect(sibling.education.level).not.toBe('less_than_hs')
    }
    expect(checkInvariants(family, content)).toEqual([])
  })
})

describe('getting into college', () => {
  const s = findStriver('college', 19, (x) => kinds(x, 'admission').length >= 3 && kinds(x, 'college_started').length > 0)

  it('the test gives a real score', () => {
    const score = kinds(s, 'test_score')[0]!.fact.data
    expect(Number(score.total)).toBe(Number(score.verbal) + Number(score.math))
    expect(Number(score.verbal) % 10).toBe(0)
    expect(Number(score.total)).toBeGreaterThanOrEqual(400)
    expect(Number(score.total)).toBeLessThanOrEqual(1600)
    expect(perceive(s, content).school.facts.some((f) => f.label === 'SAT' && f.value.startsWith(String(score.total)))).toBe(true)
  })

  it('each application is decided on the record, and "Why?" says how', () => {
    const letters = kinds(s, 'admission')
    expect(letters.length).toBeGreaterThanOrEqual(3)
    for (const letter of letters) {
      const outcome = s.outcomes[letter.fact.outcomeId!]!
      expect(outcome.model).toBe('logit')
      expect(outcome.probability).toBeGreaterThan(0)
      expect(outcome.probability).toBeLessThan(1)
      const why = explainOutcome(s, content, outcome.id)!
      expect(why.lines[0]).toMatch(/applicants with an average record are admitted to a/)
      // Grades always count, one way or the other.
      expect(why.lines.some((l) => l.includes('your grades were'))).toBe(outcome.factors.some((f) => f.id === 'adm_grades'))
      for (const line of why.lines.slice(1)) expect(line).toMatch(/^In your case it was (more|less) likely, because /)
    }
    // More selective colleges are harder to get into for the same applicant.
    const chance = (tier: string): number => s.outcomes[letters.find((l) => l.fact.data.tier === tier)!.fact.outcomeId!]!.probability
    expect(chance('elite')).toBeLessThan(chance('private_selective'))
    expect(chance('private_selective')).toBeLessThan(chance('public_regional'))
  })

  it('the choice shows what each college would cost this family', () => {
    // Step back to the month the answers arrived and look at the decision as the player sees it.
    let again = play(s.meta.seed, 'striver', 17)
    while (!again.decisions.some((d) => d.source === 'system:edu.choose')) {
      for (const d of again.decisions) again = step(again, { type: 'decide', decisionId: d.id, optionId: d.options[d.options.length - 1]!.id }, env).state
      again = step(again, { type: 'advance', until: 'month' }, env).state
      if (ageOf(again) > 19) throw new Error('no choice was offered')
    }
    const decision = perceive(again, content).decisions.find((d) => d.prompt.includes('until the end of May') || d.prompt.includes('community college'))!
    expect(decision.dueText).toMatch(/Decide by the end of May/)
    expect(decision.options.at(-1)!.label).toBe('Do not go to college this year')
    for (const option of decision.options.slice(0, -1)) {
      expect(option.label).toMatch(/^Enroll at /)
      expect(option.costs[0]).toMatch(/^(\$[\d,]+|no cost to you)$/)
    }
  })

  it('college starts in September with a bill, a share from home and, if needed, a loan', () => {
    const start = kinds(s, 'college_started')[0]!
    expect(start.month % 12).toBe(8)
    const price = start.fact.data
    expect(Number(price.parentsPay)).toBeGreaterThanOrEqual(0)
    expect(Number(price.parentsPay)).toBeLessThanOrEqual(Number(price.netPrice))
    for (const loan of kinds(s, 'loan_signed')) {
      expect(Number(loan.fact.data.amount)).toBeLessThanOrEqual(7500)
      expect(Number(loan.fact.data.total)).toBeLessThanOrEqual(cfg.paying.loans.aggregate)
    }
    expect(self(s).education.loans).toBe(kinds(s, 'loan_signed').reduce((a, e) => a + Number(e.fact.data.amount), 0))
  })
})

describe('college', () => {
  const graduate = findStriver('degree', 26, (x) => kinds(x, 'degree_earned').some((e) => e.fact.data.which === 'bachelor'))

  it('is terms, grades and credits until there are enough of them', () => {
    const terms = kinds(graduate, 'term_grades')
    expect(terms.length).toBeGreaterThanOrEqual(8)
    expect(terms.every((e) => e.month % 12 === 11 || e.month % 12 === 4)).toBe(true)
    const credits = terms.map((e) => Number(e.fact.data.credits))
    for (let i = 1; i < credits.length; i++) expect(credits[i]!).toBeGreaterThanOrEqual(credits[i - 1]! - 60)
    const degree = kinds(graduate, 'degree_earned').find((e) => e.fact.data.which === 'bachelor')!
    expect(self(graduate).education.level).toBe('bachelor')
    expect(self(graduate).education.status).toBe('out')
    expect(self(graduate).education.college).toBeNull()
    expect(perceive(graduate, content).school.attained).toBe("Bachelor's degree")
    expect(degree.text).toMatch(/bachelor's degree/i)
    expect(checkInvariants(graduate, content)).toEqual([])
  })

  it('lets a student change major, at a cost in credits once well under way', () => {
    let s = play(graduate.meta.seed, 'striver', 20)
    while (self(s).education.status !== 'college' || self(s).education.college!.terms < 2) s = playYear(s, 'striver', env)
    const action = perceive(s, content).actions.find((a) => a.id === 'edu.change_major')!
    expect(action.choices.length).toBeGreaterThan(3)
    expect(() => step(s, { type: 'act', action: 'edu.change_major' }, env)).toThrow(EngineError)
    const before = self(s).education.college!.credits
    const target = action.choices[0]!.id
    const after = step(s, { type: 'act', action: 'edu.change_major', choice: target }, env)
    expect(self(after.state).education.college!.major).toBe(target)
    expect(self(after.state).education.college!.credits).toBe(before - cfg.college.changeMajorCredits)
    expect(after.facts[0]!.kind).toBe('major_chosen')
  })

  it('can be left, and the loans come along', () => {
    let s = play(graduate.meta.seed, 'striver', 20)
    while (self(s).education.status !== 'college') s = playYear(s, 'striver', env)
    const left = step(s, { type: 'act', action: 'edu.leave_school' }, env).state
    expect(self(left).education.status).toBe('out')
    // Leaving without the degree is "some college", unless an associate degree was already in hand.
    expect(self(left).education.level).toBe(self(s).education.level === 'associate' ? 'associate' : 'some_college')
    expect(self(left).education.loans).toBe(self(s).education.loans)
    expect(left.log.at(-1)!.fact.kind).toBe('college_left')
    // And college can be gone back to.
    expect(perceive(left, content).actions.map((a) => a.id)).toEqual(expect.arrayContaining(['edu.apply', 'edu.enroll_community']))
  })
})

describe('leaving school early', () => {
  const base = liveUntil(newLife('leave-1', env, 200), env, until(16))

  it('is not possible before sixteen and is the pupil’s own act after it', () => {
    const young = liveUntil(newLife('leave-1', env, 200), env, until(15))
    expect(perceive(young, content).actions.some((a) => a.id === 'edu.leave_school')).toBe(false)
    expect(() => step(young, { type: 'act', action: 'edu.leave_school' }, env)).toThrow(EngineError)
    const left = step(base, { type: 'act', action: 'edu.leave_school' }, env).state
    expect(self(left).education.status).toBe('left_k12')
    expect(self(left).education.level).toBe('less_than_hs')
    expect(perceive(left, content).school.attained).toBe('No diploma')
    expect(perceive(left, content).routine.study).toBeNull()
  })

  it('the equivalency exam takes four months of study and is decided by where the pupil stood', () => {
    let s = step(base, { type: 'act', action: 'edu.leave_school' }, env).state
    s = liveUntil(s, env, until(17))
    expect(perceive(s, content).actions.find((a) => a.id === 'edu.equivalency')!.costs).toEqual(['5 hours a week', 'four months'])
    s = step(s, { type: 'act', action: 'edu.equivalency' }, env).state
    expect(perceive(s, content).status.conditions).toContain('Studying for the equivalency exam')
    // It cannot be started twice.
    expect(perceive(s, content).actions.some((a) => a.id === 'edu.equivalency')).toBe(false)
    for (let i = 0; i < 5; i++) s = step(s, { type: 'advance', until: 'month' }, env).state
    const result = kinds(s, 'equivalency')[0]!
    const passed = result.fact.data.which === 'passed'
    expect(self(s).education.level).toBe(passed ? 'high_school' : 'less_than_hs')
    const why = explainOutcome(s, content, result.fact.outcomeId!)!
    expect(why.lines[0]).toBe('About seven in ten people who sit the equivalency exam pass it.')
  })
})

describe('the population', () => {
  const results = runBatch({ lives: 1200, seed: 'edu-smoke', strategy: 'persona' }, { content, narrator: null })
  const e = summarize(results, content, 1).schooling

  it('breaks no invariant', () => {
    expect([...new Set(results.flatMap((r) => r.invariantProblems))]).toEqual([])
  })

  it('the norms are current: achievement at each grade is centred where the norms say', () => {
    const norms = content.bundle.country.norms
    for (const subject of ['literacy', 'math'] as const) {
      const table = norms[subject] as { mean: number[]; sd: number[] }
      for (const grade of [0, 4, 8, 11]) {
        expect(Math.abs(e.norms[subject].mean[grade]! - table.mean[grade]!) / table.sd[grade]!).toBeLessThan(0.15)
        expect(e.norms[subject].sd[grade]! / table.sd[grade]!).toBeGreaterThan(0.85)
        expect(e.norms[subject].sd[grade]! / table.sd[grade]!).toBeLessThan(1.15)
      }
    }
  })

  it('schooling lands near the national figures', () => {
    // Wide bands for a small batch; the full comparison is in docs/CALIBRATION.md.
    expect(e.graduatedOnTime).toBeGreaterThan(0.8)
    expect(e.graduatedOnTime).toBeLessThan(0.92)
    expect(e.enrolledRightAway.any).toBeGreaterThan(0.52)
    expect(e.enrolledRightAway.any).toBeLessThan(0.72)
    expect(e.bachelorAt27).toBeGreaterThan(0.3)
    expect(e.bachelorAt27).toBeLessThan(0.5)
    expect(e.meanHsGpa).toBeGreaterThan(2.85)
    expect(e.meanHsGpa).toBeLessThan(3.25)
    expect(e.meanTestTotal).toBeGreaterThan(960)
    expect(e.meanTestTotal).toBeLessThan(1100)
  })

  it('family background matters a great deal and does not decide', () => {
    // Children of richer families go further on average...
    expect(e.bachelorByIncomeQuarter[3]!).toBeGreaterThan(e.bachelorByIncomeQuarter[0]! + 0.25)
    expect(e.enrolledByIncomeQuarter[3]!).toBeGreaterThan(e.enrolledByIncomeQuarter[0]! + 0.25)
    expect(e.achievementGap9010).toBeGreaterThan(0.8)
    expect(e.achievementGap9010).toBeLessThan(1.7)
    expect(e.parentChildEducationCorrelation).toBeGreaterThan(0.3)
    expect(e.parentChildEducationCorrelation).toBeLessThan(0.6)
    // ...but a real share of the poorest quarter graduate, and a real share of the richest do not.
    expect(e.bachelorByIncomeQuarter[0]!).toBeGreaterThan(0.08)
    expect(e.bachelorByIncomeQuarter[3]!).toBeLessThan(0.85)
  })
})
