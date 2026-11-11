import { describe, expect, it } from 'vitest'
import { autoChoice, checkInvariants, createLife, perceive, step, type GameState } from '../src/engine'
import { offerChance, occupationOf, qualifies } from '../src/engine/country/us/work'
import { explainOutcome } from '../src/narrative'
import { playYear, type Strategy } from '../src/tools/players'
import { liveUntil, newLife, realContent, testEnv } from './helpers'

const content = realContent()
const env = testEnv(content, true)
const quiet = testEnv(content, false)
const self = (s: GameState) => s.people.p1!

describe('the economy', () => {
  it('is the same whatever the player does, so paired lives share their recessions', () => {
    const run = (strategy: Strategy): number[] => {
      let s = newLife('econ-pair', quiet)
      const path: number[] = []
      while (s.phase === 'alive' && path.length < 50) {
        s = playYear(s, strategy, quiet)
        path.push(Math.round(s.world.unemployment * 1000), Math.round(s.world.priceLevel * 1e6))
      }
      return path.slice(0, 40)
    }
    expect(run('striver')).toEqual(run('drifter'))
  })
})

describe('work', () => {
  it('nobody is hired into work that needs a qualification they lack', () => {
    const s = newLife('qual-1', quiet)
    const me = self(s)
    me.education.level = 'bachelor'
    me.born = s.now - 12 * 30
    expect(qualifies(s, content, me, occupationOf(content, 'physician'))).toBe(false)
    expect(qualifies(s, content, me, occupationOf(content, 'cashier'))).toBe(true)
    me.credentials.push('medical_degree')
    me.education.level = 'graduate'
    expect(qualifies(s, content, me, occupationOf(content, 'physician'))).toBe(true)
  })

  it('a documented hiring gap appears in the odds, and in "Why?", for the groups it applies to', () => {
    const s = newLife('callback-1', quiet)
    const me = self(s)
    me.born = s.now - 12 * 30
    const occ = occupationOf(content, 'customer_service_rep')
    me.ethnicity = 'white'
    const white = offerChance({ state: s, content }, me, occ)
    me.ethnicity = 'black'
    const black = offerChance({ state: s, content }, me, occ)
    expect(black.probability).toBeLessThan(white.probability)
    expect(black.factors.some((f) => f.id === 'job_callbacks' && f.contribution < 0)).toBe(true)
    expect(white.factors.some((f) => f.id === 'job_callbacks')).toBe(false)
  })

  it('a life has jobs, offers to answer and reasons to give', () => {
    let found: GameState | null = null
    for (let i = 0; i < 40 && !found; i++) {
      let s = createLife({ seed: `job-${i}`, start: { protectPlayerUntilAge: 200 } }, env)
      s = liveUntil(s, env, (x) => x.now - self(x).born >= 12 * 22)
      for (let m = 0; m < 12 * 20 && s.phase === 'alive'; m++) {
        const offer = s.decisions.find((d) => d.source === 'system:work.offer')
        if (offer) {
          s = step(s, { type: 'decide', decisionId: offer.id, optionId: 'accept' }, env).state
          found = s
          break
        }
        for (const d of s.decisions) s = step(s, { type: 'decide', decisionId: d.id, optionId: autoChoice(s, d, env) }, env).state
        s = step(s, { type: 'advance', until: 'month' }, env).state
      }
    }
    expect(found).not.toBeNull()
    const s = found!
    expect(self(s).work?.job).not.toBeNull()
    expect(s.log.some((e) => e.fact.kind === 'hired' && e.text.length > 20)).toBe(true)
    const view = perceive(s, content)
    expect(view.work.line).toMatch(/ at /)
    expect(view.work.facts.some((f) => f.label === 'Pay')).toBe(true)
    expect(checkInvariants(s, content)).toEqual([])
  })

  it('a long search can be asked about, and the answer names what counted', () => {
    for (let i = 0; i < 300; i++) {
      let s = newLife(`search-${i}`, quiet, 200)
      while (s.phase === 'alive' && s.now - self(s).born < 12 * 50) s = playYear(s, 'persona', quiet)
      const report = s.log.find((e) => e.fact.kind === 'search_report' && e.fact.outcomeId)
      if (!report) continue
      const answer = explainOutcome(s, content, report.fact.outcomeId!)
      expect(answer).not.toBeNull()
      expect(answer!.lines[0]).toMatch(/applications fail/)
      expect(answer!.lines.length).toBeGreaterThan(1)
      return
    }
    throw new Error('no life with a long job search')
  })

  it('people retire and draw Social Security', () => {
    let claimed = 0
    let reached = 0
    for (let i = 0; i < 25; i++) {
      let s = newLife(`retire-${i}`, quiet, 200)
      while (s.phase === 'alive' && s.now - self(s).born < 12 * 72) s = playYear(s, 'persona', quiet)
      if (s.phase !== 'alive') continue
      reached++
      if (self(s).work?.benefit) claimed++
    }
    expect(reached).toBeGreaterThan(10)
    // Everyone has claimed by seventy.
    expect(claimed).toBe(reached)
  })
})
