import { describe, expect, it } from 'vitest'
import { EngineError, checkInvariants, perceive, stateHash, step, type GameState, type Prepared } from '../src/engine'
import { monthlyFromAnnual } from '../src/engine/content/prepare'
import { KeyedRng } from '../src/engine/core/rng'
import { bandFor } from '../src/engine/systems/perception'
import { tableTargets } from '../src/tools/batch-lib'
import { ageOf, bareContent, liveUntil, newLife, realContent, testEnv } from './helpers'

const IMMORTAL = 500
const self = (s: GameState) => s.people[s.playerId]!
const facts = (s: GameState, kind: string) => s.log.filter((e) => e.fact.kind === kind)
const advanceMonths = (s: GameState, n: number, content: Prepared): GameState => {
  for (let i = 0; i < n; i++) s = step(s, { type: 'advance', until: 'month' }, testEnv(content)).state
  return s
}

/** Custom events and their text, on top of the bare content. */
const withEvents = (events: string, text = '', processes = ''): Prepared =>
  bareContent({
    'core/events/zz-test.yaml': events,
    ...(text ? { 'core/text/zz-test.yaml': text } : {}),
    ...(processes ? { 'core/processes/zz-test.yaml': processes } : {}),
  })

describe('time', () => {
  it('a birthday advance covers exactly twelve months and ends on the birthday', () => {
    const content = bareContent()
    let s = newLife('time-1', testEnv(content), IMMORTAL)
    const born = self(s).born
    expect(s.now).toBe(born)
    s = step(s, { type: 'advance', until: 'birthday' }, testEnv(content)).state
    expect(s.now).toBe(born + 12)
    s = step(s, { type: 'advance', until: 'month' }, testEnv(content)).state
    expect(s.now).toBe(born + 13)
    s = step(s, { type: 'advance', until: 'season' }, testEnv(content)).state
    expect(s.now).toBe(born + 16)
    // From mid-year, a birthday advance stops at the next birthday, not twelve months on.
    s = step(s, { type: 'advance', until: 'birthday' }, testEnv(content)).state
    expect(s.now).toBe(born + 24)
  })

  it('writes one year summary per year lived, labelled with the age during that year', () => {
    const content = bareContent()
    const s = liveUntil(newLife('time-2', testEnv(content), IMMORTAL), testEnv(content), (x) => ageOf(x) >= 10)
    const summaries = facts(s, 'year_summary')
    expect(summaries.map((e) => e.fact.data.age)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(summaries[0]!.text.startsWith('Your first year.')).toBe(true)
    expect(summaries[9]!.text.startsWith('Age 9.')).toBe(true)
  })
})

describe('body stocks', () => {
  const content = bareContent()
  const env = testEnv(content)
  const adult = liveUntil(newLife('body-1', env, IMMORTAL), env, (x) => ageOf(x) >= 30)

  it('one month of a new routine changes little; three years changes the body', () => {
    let s = step(adult, { type: 'setPolicy', policy: { activity: 'sedentary' } }, env).state
    s = advanceMonths(s, 48, content)
    const settled = self(s).body.cardio
    const age = (s.now - self(s).born) / 12
    expect(settled).toBeCloseTo(0.52 * content.envelope('cardio', age), 2)

    s = step(s, { type: 'setPolicy', policy: { activity: 'active' } }, env).state
    const afterOne = self(advanceMonths(s, 1, content)).body.cardio
    expect(afterOne - settled).toBeGreaterThan(0)
    expect(afterOne - settled).toBeLessThan(0.06)

    const trained = advanceMonths(s, 36, content)
    const target = 0.95 * content.envelope('cardio', (trained.now - self(trained).born) / 12)
    expect(self(trained).body.cardio).toBeGreaterThan(target - 0.01)
    expect(self(trained).body.cardio).toBeLessThanOrEqual(target + 1e-9)
  })

  it('fitness is lost faster than it is gained', () => {
    const up = step(step(adult, { type: 'setPolicy', policy: { activity: 'sedentary' } }, env).state, { type: 'advance', until: 'birthday' }, env).state
    let fit = step(adult, { type: 'setPolicy', policy: { activity: 'active' } }, env).state
    fit = advanceMonths(fit, 48, content)
    const before = self(fit).body.cardio
    const afterStop = self(advanceMonths(step(fit, { type: 'setPolicy', policy: { activity: 'sedentary' } }, env).state, 3, content)).body.cardio
    let unfit = advanceMonths(up, 36, content)
    const low = self(unfit).body.cardio
    unfit = step(unfit, { type: 'setPolicy', policy: { activity: 'active' } }, env).state
    const afterStart = self(advanceMonths(unfit, 3, content)).body.cardio
    // Three months off costs more than half the gap; three months on recovers well under half.
    expect((before - afterStop) / (before - low)).toBeGreaterThan(0.5)
    expect((afterStart - low) / (before - low)).toBeLessThan(0.4)
  })

  it('the cause ledger accounts for every change', () => {
    const s = liveUntil(adult, env, (x) => ageOf(x) >= 45)
    for (const stock of ['cardio', 'strength'] as const) {
      let total = 0
      const years = s.ledger[s.playerId]!
      for (const age in years) for (const cause in years[age]![stock] ?? {}) total += years[age]![stock]![cause]!
      expect(content.bundle.body.stocks[stock]!.atBirth + total).toBeCloseTo(self(s).body[stock], 9)
    }
    // Growing dominates childhood; aging appears afterwards.
    const years = s.ledger[s.playerId]!
    expect(years['8']!.cardio!.growing).toBeGreaterThan(0)
    expect(years['40']!.cardio!.aging).toBeLessThan(0)
  })

  it('refuses a routine the character is too young to set, or that does not exist', () => {
    const baby = newLife('body-2', env, IMMORTAL)
    expect(() => step(baby, { type: 'setPolicy', policy: { activity: 'active' } }, env)).toThrow(EngineError)
    expect(() => step(adult, { type: 'setPolicy', policy: { activity: 'flying' } }, env)).toThrow(EngineError)
    const changed = step(adult, { type: 'setPolicy', policy: { activity: 'light' } }, env)
    expect(changed.facts.map((f) => f.kind)).toEqual(['activity_changed'])
    // Setting the level it already has is not an event.
    expect(step(changed.state, { type: 'setPolicy', policy: { activity: 'light' } }, env).facts).toEqual([])
  })
})

describe('events', () => {
  it('once-only events fire once; cooldown events keep their distance', () => {
    const content = withEvents(
      `
- { id: t.once, sourceClass: structural, once: true, when: "self.age >= 2", fact: { kind: t_once } }
- { id: t.cool, sourceClass: structural, cooldownMonths: 24, when: "self.age >= 2", fact: { kind: t_cool } }
`,
      `
- { id: t.once, fact: t_once, variants: [{ text: "once" }] }
- { id: t.cool, fact: t_cool, variants: [{ text: "again" }] }
`,
    )
    const s = liveUntil(newLife('ev-1', testEnv(content), IMMORTAL), testEnv(content), (x) => ageOf(x) >= 12)
    expect(facts(s, 't_once')).toHaveLength(1)
    const months = facts(s, 't_cool').map((e) => e.month)
    expect(months.length).toBe(5)
    for (let i = 1; i < months.length; i++) expect(months[i]! - months[i - 1]!).toBe(24)
    expect(months[0]).toBe(self(s).born + 24)
  })

  it('a hazard event records the factors that were in play, for "Why?"', () => {
    const content = withEvents(
      `
- id: t.risk
  sourceClass: chance
  cooldownMonths: 1
  when: "self.age >= 1"
  hazard:
    base: { perYear: 6, population: test, source: test, asOf: 2026 }
    factors:
      - { id: flu_season, when: "world.month <= 6", beta: 0.7 }
      - { id: illness, value: "self.age", beta: 0 }
  fact: { kind: t_risk }
`,
      `- { id: t.risk, fact: t_risk, variants: [{ text: "risk" }] }`,
    )
    const s = liveUntil(newLife('ev-2', testEnv(content), IMMORTAL), testEnv(content), (x) => ageOf(x) >= 6)
    const entries = facts(s, 't_risk')
    expect(entries.length).toBeGreaterThan(5)
    for (const entry of entries) {
      const outcome = s.outcomes[entry.fact.outcomeId!]!
      expect(outcome.base).toBe(6)
      const firstHalf = (entry.month % 12) + 1 <= 6
      // A factor with no effect on the odds is not recorded.
      expect(outcome.factors).toEqual(firstHalf ? [{ id: 'flu_season', contribution: 0.7 }] : [])
      expect(outcome.probability).toBeGreaterThan(0)
      expect(outcome.probability).toBeLessThan(1)
    }
  })
})

describe('decisions', () => {
  const decisionEvent = (cls: string, extra = ''): string => `
- id: t.choice
  sourceClass: structural
  once: true
  when: "self.ageMonths >= 30"
  ${extra}
  decision:
    class: ${cls}
    deadlineMonths: 2
    prompt: prompt.t
    options:
      - { id: yes, label: "Say yes at {self.age}", cost: { hoursPerWeek: 3, money: 120, energy: high }, effects: [{ setFlag: { name: chose, value: "'yes'" } }], autoWeight: 0 }
      - { id: no, label: "Say no", effects: [{ setFlag: { name: chose, value: "'no'" } }], fact: { kind: t_said_no }, autoWeight: 1 }
`
  const text = `
- { id: prompt.t, variants: [{ text: "A question arrives." }] }
- id: t.no
  fact: t_said_no
  variants:
    - { when: "fact.lapsed", text: "You never answered." }
    - { when: "!fact.lapsed", text: "You said no." }
`

  it('a blocking decision stops time until it is answered', () => {
    const content = withEvents(decisionEvent('blocking'), text)
    const env = testEnv(content)
    const first = step(liveUntil(newLife('dec-1', env, IMMORTAL), env, (x) => ageOf(x) >= 2), { type: 'advance', until: 'birthday' }, env)
    const s = first.state
    expect(first.pending).toHaveLength(1)
    expect(s.now).toBe(self(s).born + 31) // stopped in the month it opened, not at the birthday

    const view = perceive(s, content)
    expect(view.advance.allowed).toBe(false)
    expect(view.decisions[0]!.prompt).toBe('A question arrives.')
    expect(view.decisions[0]!.options[0]).toEqual({ id: 'yes', label: 'Say yes at 2', costs: ['3 hours a week', '$120', 'takes a lot of energy'] })
    expect(view.feed.at(-1)!.decisionId).toBe(view.decisions[0]!.id)

    const stuck = step(s, { type: 'advance', until: 'birthday' }, env).state
    expect(stuck.now).toBe(s.now)

    const answered = step(s, { type: 'decide', decisionId: first.pending[0]!.id, optionId: 'yes' }, env).state
    expect(self(answered).flags.chose).toBe('yes')
    expect(answered.decisions).toHaveLength(0)
    expect(perceive(answered, content).feed.at(-1)!.text).toBe('Chose Say yes at 2.')
    expect(step(answered, { type: 'advance', until: 'birthday' }, env).state.now).toBe(self(s).born + 36)
  })

  it('a deferrable decision stops time once, then lapses in character', () => {
    const content = withEvents(decisionEvent('deferrable'), text)
    const env = testEnv(content)
    let s = step(liveUntil(newLife('dec-2', env, IMMORTAL), env, (x) => ageOf(x) >= 2), { type: 'advance', until: 'birthday' }, env).state
    const opened = s.now - 1
    expect(s.decisions[0]!.deadline).toBe(opened + 2)
    expect(perceive(s, content).advance.allowed).toBe(true)

    s = step(s, { type: 'advance', until: 'month' }, env).state
    s = step(s, { type: 'advance', until: 'month' }, env).state
    expect(s.decisions).toHaveLength(1) // still open through its deadline month
    s = step(s, { type: 'advance', until: 'month' }, env).state
    expect(s.decisions).toHaveLength(0)
    expect(self(s).flags.chose).toBe('no') // the only option with any weight
    expect(s.log.at(-1)!.fact.data.lapsed).toBe(true)
    expect(s.log.at(-1)!.text).toBe('You never answered.')
  })

  it('rejects answers to decisions or options that do not exist', () => {
    const content = withEvents(decisionEvent('blocking'), text)
    const env = testEnv(content)
    const s = step(liveUntil(newLife('dec-3', env, IMMORTAL), env, (x) => ageOf(x) >= 2), { type: 'advance', until: 'birthday' }, env).state
    expect(() => step(s, { type: 'decide', decisionId: 'nope', optionId: 'yes' }, env)).toThrow(EngineError)
    expect(() => step(s, { type: 'decide', decisionId: s.decisions[0]!.id, optionId: 'maybe' }, env)).toThrow(EngineError)
  })

  it('the governor caps optional offers per year but never required ones', () => {
    const offer = (id: string, optional: boolean): string => `
- id: ${id}
  sourceClass: structural
  optional: ${optional}
  cooldownMonths: 1
  when: "self.age >= 7 && self.age < 12"
  hazard: { base: { perYear: 30, population: test, source: test, asOf: 2026 } }
  decision:
    class: deferrable
    prompt: prompt.t
    options: [{ id: a, label: A }, { id: b, label: B }]
`
    const count = (content: Prepared): number[] => {
      const env = testEnv(content)
      const s = liveUntil(newLife('gov-1', env, IMMORTAL), env, (x) => ageOf(x) >= 12)
      const months = facts(s, 'decision_opened').map((e) => e.month)
      // Most decisions opened in any rolling twelve months.
      let most = 0
      for (const m of months) most = Math.max(most, months.filter((x) => x >= m && x < m + 12).length)
      return [months.length, most]
    }
    const prompt = `- { id: prompt.t, variants: [{ text: "A question arrives." }] }`
    const [optionalTotal, optionalMost] = count(withEvents(offer('t.offer', true), prompt))
    expect(optionalTotal).toBeGreaterThanOrEqual(4)
    expect(optionalMost).toBe(1) // the childhood cap in pacing.yaml
    const [, requiredMost] = count(withEvents(offer('t.offer', false), prompt))
    expect(requiredMost).toBeGreaterThan(3)
  })
})

describe('processes', () => {
  const content = withEvents(
    `
- { id: t.start, sourceClass: chance, once: true, when: "self.ageMonths >= 24", effects: [{ startProcess: ordeal }], fact: { kind: t_started } }
- { id: t.again, sourceClass: chance, once: true, when: "self.ageMonths >= 25", effects: [{ startProcess: ordeal }], fact: { kind: t_started } }
`,
    `
- { id: t.started, fact: t_started, variants: [{ text: "It begins." }] }
- { id: t.stage, fact: t_stage, variants: [{ text: "Stage {fact.stage} after {fact.months}." }] }
- { id: t.sign, fact: t_sign, variants: [{ text: "A sign." }] }
`,
    `
- id: ordeal
  stages:
    - id: first
      status: In the first stage
      duration: { months: [3, 3] }
      monthly: [{ adjust: { stock: strength, delta: -0.01, cause: illness } }]
      signals:
        - { id: seen, notice: "process.monthsInStage == 1", fact: { kind: t_sign } }
      onExit: [{ emit: { kind: t_stage, data: { stage: "'first-done'", months: process.months } } }]
      next: second
    - id: second
      duration: { months: [6, 6] }
      onEnter: [{ emit: { kind: t_stage, data: { stage: process.stage, months: process.months } } }]
      transitions:
        - { to: end, when: "process.monthsInStage >= 2" }
`,
  )
  const env = testEnv(content)
  const start = liveUntil(newLife('proc-1', env, IMMORTAL), env, (x) => ageOf(x) >= 2)

  it('runs stages for their duration, applies monthly effects that many times, and ends', () => {
    let s = advanceMonths(start, 1, content) // month 24: process starts
    expect(Object.values(s.processes)).toHaveLength(1)
    expect(perceive(s, content).status.conditions).toEqual(['In the first stage'])

    s = advanceMonths(s, 1, content) // month 25: a second start is ignored while one is running
    expect(Object.values(s.processes)).toHaveLength(1)

    s = advanceMonths(s, 2, content) // months 26, 27: third monthly effect, then on to the second stage
    expect(Object.values(s.processes)[0]!.stage).toBe('second')
    const illness = Object.values(s.ledger[s.playerId]!).reduce((a, year) => a + (year.strength?.illness ?? 0), 0)
    expect(illness).toBeCloseTo(-0.03, 9)
    expect(facts(s, 't_stage').map((e) => e.text)).toEqual(['Stage first-done after 3.', 'Stage second after 3.'])

    s = advanceMonths(s, 2, content) // the transition fires after two months, well before the six are up
    expect(Object.values(s.processes)).toHaveLength(0)
    expect(perceive(s, content).status.conditions).toEqual([])
    expect(checkInvariants(s, content)).toEqual([])
  })

  it('logs unnoticed signals as hidden and keeps them out of the feed', () => {
    const s = advanceMonths(start, 5, content)
    const signs = facts(s, 't_sign')
    expect(signs.map((e) => e.hidden)).toEqual([false, true, true])
    expect(perceive(s, content).feed.filter((f) => f.kind === 't_sign')).toHaveLength(1)
  })
})

describe('perception', () => {
  const descriptor = { id: 'x', margin: 0.02, bands: [{ id: 'low', upTo: 0.4, text: 'low' }, { id: 'mid', upTo: 0.7, text: 'mid' }, { id: 'high', text: 'high' }] }

  it('wording has hysteresis: it changes only once the value is clearly past a boundary', () => {
    expect(bandFor(descriptor, 0.39)).toBe('low')
    expect(bandFor(descriptor, 0.41, 'low')).toBe('low')
    expect(bandFor(descriptor, 0.43, 'low')).toBe('mid')
    expect(bandFor(descriptor, 0.39, 'mid')).toBe('mid')
    expect(bandFor(descriptor, 0.37, 'mid')).toBe('low')
    expect(bandFor(descriptor, 0.95, 'low')).toBe('high')
    expect(bandFor(descriptor, 0.5, 'gone')).toBe('mid')
  })

  it('a slow decline is noticed as a change of band, with words rather than numbers', () => {
    const content = bareContent()
    const env = testEnv(content)
    let s = liveUntil(newLife('perc-1', env, IMMORTAL), env, (x) => ageOf(x) >= 30)
    s = step(s, { type: 'setPolicy', policy: { activity: 'sedentary' } }, env).state
    s = liveUntil(s, env, (x) => ageOf(x) >= 70)
    // Work now adds strain too, which has its own words; what the body does is told as stamina.
    const changes = facts(s, 'band_changed').filter((e) => e.fact.data.descriptor === 'stamina')
    expect(changes.length).toBeGreaterThanOrEqual(2)
    expect(changes.every((e) => e.fact.data.direction === 'down')).toBe(true)

    const view = perceive(s, content)
    expect(view.status.health).toMatch(/^[a-z ]+$/)
    // No hidden number leaves the engine.
    const json = JSON.stringify(view)
    expect(json).not.toContain(String(self(s).body.cardio))
    expect(json).not.toContain('"body"')
    expect(json).not.toContain('"ledger"')
  })
})

describe('mortality', () => {
  it('the data reproduces the published life expectancies', () => {
    const content = realContent()
    // NCHS, United States Life Tables, 2023: 75.8 years for males and 81.1 for females.
    expect(tableTargets(content, 'male').lifeExpectancy).toBeCloseTo(75.82, 1)
    expect(tableTargets(content, 'female').lifeExpectancy).toBeCloseTo(81.08, 1)
    expect(content.annualMortality('male', 0)).toBeCloseTo(0.00602267, 8)
    expect(content.annualMortality('female', 99)).toBeCloseTo(0.30364355, 8)
    expect(content.annualMortality('male', 105)).toBeCloseTo(1 / 2.5126, 6)
    expect(content.annualMortality('female', 120)).toBe(1)
  })

  it('every death falls exactly where the life table and the seed put it', () => {
    const content = bareContent()
    const env = { content, narrator: null }
    for (let i = 0; i < 150; i++) {
      const seed = `exact-${i}`
      let s = newLife(seed, env)
      const { born, sex } = self(s)
      const rng = new KeyedRng(seed)
      let expected = born
      while (!(rng.float('mortality', 'p1', expected) < monthlyFromAnnual(content.annualMortality(sex, Math.floor((expected - born) / 12))))) expected++
      while (s.phase === 'alive') s = step(s, { type: 'advance', until: 'birthday' }, { ...env, mutate: true }).state
      expect(self(s).died!.at).toBe(expected)
      expect(s.now).toBe(expected)
    }
  })

  it('nobody outlives the maximum age', () => {
    const content = bareContent({
      'countries/us/demographics/life-table.csv': 'age,qx_male,qx_female,qx_total\n' + Array.from({ length: 100 }, (_, a) => `${a},0,0,0`).join('\n'),
      'countries/us/demographics/life-table.yaml': 'source: test\nasOf: 2026\nopenIntervalLifeExpectancy: { male: 1000000000, female: 1000000000 }\nmaxAge: 120\n',
    })
    const env = testEnv(content, false)
    const s = liveUntil(newLife('old-1', env), env, () => false, 200)
    expect(s.phase).toBe('ended')
    expect(ageOf(s)).toBe(120)
    expect(checkInvariants(s, content)).toEqual([])
  })

  it('interactive play can protect the player character in early childhood', () => {
    const content = bareContent()
    const env = { content, narrator: null }
    // Find a seed whose unprotected life ends before five.
    let seed = ''
    for (let i = 0; i < 5000 && !seed; i++) {
      const s = liveUntil(newLife(`short-${i}`, env), env, (x) => ageOf(x) >= 5)
      if (s.phase === 'ended') seed = `short-${i}`
    }
    expect(seed).not.toBe('')
    const guarded = liveUntil(newLife(seed, env, 5), env, (x) => ageOf(x) >= 5)
    expect(guarded.phase).toBe('alive')
    expect(ageOf(guarded)).toBe(5)
  })

  it('the dead do nothing', () => {
    const content = realContent()
    const env = testEnv(content)
    const s = liveUntil(newLife('dead-1', env), env, () => false)
    expect(s.phase).toBe('ended')
    expect(Object.keys(s.processes)).toHaveLength(0)
    expect(s.decisions).toHaveLength(0)
    expect(s.log.at(-1)!.fact.kind).toBe('obituary')
    expect(s.log.at(-2)!.fact.kind).toBe('death')
    const before = stateHash(s)
    for (const command of [{ type: 'advance', until: 'birthday' }, { type: 'setPolicy', policy: { activity: 'active' } }] as const) {
      const after = step(s, command, env)
      expect(after.facts).toEqual([])
      expect(stateHash(after.state)).toBe(before)
    }
    const view = perceive(s, content)
    expect(view.advance.allowed).toBe(false)
    expect(view.death!.age).toBe(ageOf(s))
  })
})
