import { describe, expect, it } from 'vitest'
import { perceive, step, type GameState } from '../src/engine'
import { spanWords } from '../src/engine/views'
import { explainOutcome, oneIn } from '../src/narrative'
import { playYear } from '../src/tools/players'
import { liveUntil, newLife, realContent, testEnv } from './helpers'

const env = testEnv()
const content = realContent()
const lives: GameState[] = Array.from({ length: 25 }, (_, i) => {
  let s = newLife(`story-${i}`, env)
  while (s.phase === 'alive') s = playYear(s, i % 2 ? 'random' : 'persona', env)
  return s
})

describe('narrative', () => {
  it('every fact that reaches the log has prose', () => {
    for (const life of lives) {
      for (const entry of life.log) expect(entry.text, `${entry.fact.kind} ${JSON.stringify(entry.fact.data)}`).not.toBe('')
    }
  })

  it('prose never shows a raw placeholder, an unrounded number or a missing value', () => {
    for (const life of lives) {
      for (const entry of life.log) {
        expect(entry.text).not.toMatch(/[{}]|undefined|null|NaN|\d\.\d{3,}/)
        expect(entry.text).toMatch(/[.?!"]$/)
      }
    }
  })

  it('a life ends with a death and an obituary drawn from that life', () => {
    for (const life of lives) {
      const self = life.people.p1!
      const obituary = life.log.at(-1)!
      expect(obituary.fact.kind).toBe('obituary')
      expect(obituary.text).toContain(`${self.name.first} ${self.name.family}`)
      expect(obituary.text).toContain(String(Math.floor(self.born / 12)))
    }
  })

  it('avoids repeating a variant while others are available', () => {
    // Thirty is a decade birthday with two variants; both must be used before either repeats.
    const used = new Set<string>()
    for (const life of lives) {
      for (const e of life.log) if (e.fact.kind === 'milestone' && e.fact.data.age === 30) used.add(e.text)
    }
    expect(used.size).toBe(2)
    for (const life of lives) {
      const flu = life.log.filter((e) => e.fact.kind === 'illness_started' && e.age >= 18 && e.age < 70).slice(0, 3).map((e) => e.templateId)
      expect(new Set(flu).size).toBe(flu.length)
    }
  })

  it('describes time spans and odds the way a person would', () => {
    expect([0, 1, 5, 12, 14, 18, 30, 36, 47, 120].map(spanWords)).toEqual(['a few weeks', 'a month', 'five months', 'a year', 'a year', 'a year and a half', 'two and a half years', 'three years', 'four years', 'ten years'])
    expect([0.5, 0.1, 0.08, 0.02, 0.0043, 0.0006, 0.00002].map(oneIn)).toEqual(['two', 'ten', '13', '50', '230', '1,700', '50,000'])
  })

  it('"Why?" answers from the recorded outcome: base rate first, then what moved the odds', () => {
    let explainedSeason = false
    for (const life of lives) {
      const death = explainOutcome(life, content, life.people.p1!.died!.outcomeId)!
      expect(death.subject).toBe(life.log.at(-2)!.text)
      expect(death.lines[0]).toMatch(/about one (man|woman|boy|girl) in /)

      for (const entry of life.log.filter((e) => e.fact.kind === 'illness_started')) {
        const why = explainOutcome(life, content, entry.fact.outcomeId!)!
        expect(why.lines[0]).toBe('About one person in 13 gets the flu in an average year.')
        const month = (entry.month % 12) + 1
        const inSeason = month === 12 || month <= 3
        expect(why.lines.includes('In your case it was more likely, because it was flu season.')).toBe(inSeason)
        explainedSeason ||= inSeason
      }
    }
    expect(explainedSeason).toBe(true)
    expect(explainOutcome(lives[0]!, content, 'no-such-outcome')).toBeNull()
  })

  it('the feed offers "Why?" exactly where an outcome was recorded', () => {
    const view = perceive(lives[0]!, content)
    for (const item of view.feed) {
      if (item.whyId) expect(lives[0]!.outcomes[item.whyId]).toBeDefined()
    }
    expect(view.feed.some((f) => f.whyId)).toBe(true)
    expect(view.feed.some((f) => f.kind === 'year_summary' && !f.whyId)).toBe(true)
  })

  it('a decision is presented with its prompt, costs in words and a deadline', () => {
    let s = newLife('story-decision', env, 200)
    s = liveUntil(s, env, (x) => x.decisions.length > 0, 60)
    if (s.decisions.length === 0) s = step(s, { type: 'advance', until: 'birthday' }, env).state
    const open = perceive(s, content).decisions
    for (const d of open) {
      expect(d.prompt.length).toBeGreaterThan(20)
      expect(d.dueText).toMatch(/^Decide by the end of [A-Z][a-z]+ \d{4}$/)
      expect(d.options.length).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('repetition', () => {
  it('does not use the same year-summary sentence two years running', () => {
    let pairs = 0
    let repeats = 0
    for (const life of lives) {
      const summaries = life.log.filter((e) => e.fact.kind === 'year_summary')
      for (let i = 1; i < summaries.length; i++) {
        pairs++
        if (summaries[i]!.templateId === summaries[i - 1]!.templateId) repeats++
      }
    }
    // Milestone 1 has few sentences for a long life, so a rare back-to-back repeat is tolerated;
    // a quarter of all years, as before recency was graded, is not.
    expect(repeats / pairs).toBeLessThan(0.03)
  })
})
