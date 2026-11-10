import { describe, expect, it } from 'vitest'
import { replay, simulationHash, stateHash, step, type GameState } from '../src/engine'
import { playYear } from '../src/tools/players'
import { contentWith, liveUntil, newLife, realContent, realFiles, testEnv } from './helpers'

const playOut = (seed: string, env = testEnv()): GameState => {
  let s = newLife(seed, env)
  while (s.phase === 'alive') s = playYear(s, 'random', env)
  return s
}
const deathMonth = (s: GameState): number => s.people[s.playerId]!.died!.at
const kinds = (s: GameState, kind: string): number[] => s.log.filter((e) => e.fact.kind === kind).map((e) => e.month)

describe('determinism', () => {
  it('the same seed and choices give the same life, to the last bit', () => {
    const a = playOut('det-1')
    const b = playOut('det-1')
    expect(stateHash(a)).toBe(stateHash(b))
    expect(stateHash(playOut('det-2'))).not.toBe(stateHash(a))
  })

  it('a life can be rebuilt from its seed and command log', () => {
    const original = playOut('det-3')
    const rebuilt = replay({ seed: original.meta.seed, options: original.meta.options, commands: original.meta.commandLog }, testEnv())
    expect(stateHash(rebuilt)).toBe(stateHash(original))
    expect(original.meta.commandLog.length).toBeGreaterThan(50)
  })

  it('step does not change the state it is given', () => {
    const env = testEnv()
    const s = liveUntil(newLife('det-4', env, 200), env, (x) => x.now - x.people.p1!.born >= 240)
    const before = stateHash(s)
    step(s, { type: 'advance', until: 'birthday' }, env)
    step(s, { type: 'setPolicy', policy: { activity: 'sedentary' } }, env)
    expect(stateHash(s)).toBe(before)
  })

  it('the simulation is the same with or without a narrator', () => {
    const narrated = playOut('det-5', testEnv(realContent(), true))
    const silent = playOut('det-5', testEnv(realContent(), false))
    expect(simulationHash(silent)).toBe(simulationHash(narrated))
    expect(stateHash(silent)).not.toBe(stateHash(narrated))
    expect(silent.log.every((e) => e.text === '')).toBe(true)
  })

  it('rewording text cannot change a life', () => {
    const files = realFiles()
    const reworded = contentWith({
      'core/text/health.yaml': files['core/text/health.yaml']!.replaceAll('the flu', 'influenza'),
      'core/text/summary.yaml': files['core/text/summary.yaml']!.replaceAll('quiet year', 'still year'),
    })
    const a = playOut('det-6')
    const b = playOut('det-6', testEnv(reworded))
    expect(b.log.some((e) => e.text.includes('influenza') || e.text.includes('still year'))).toBe(true)
    // Only the content hash recorded in the save differs.
    const strip = (s: GameState): string => simulationHash({ ...s, meta: { ...s.meta, contentHash: '' } })
    expect(strip(b)).toBe(strip(a))
  })

  it('adding unrelated content does not disturb existing luck', () => {
    // The point of keyed randomness (design §4.3): a new event draws from its own key, so every
    // other draw in the life stays where it was.
    const extended = contentWith({
      'core/events/zz-new.yaml': `
- id: t.hiccups
  sourceClass: chance
  cooldownMonths: 3
  hazard: { base: { perYear: 1.5, population: everyone, source: test, asOf: 2026 } }
  fact: { kind: hiccups }
`,
      'core/text/zz-new.yaml': `- { id: t.hiccups, fact: hiccups, variants: [{ text: "Hiccups." }] }`,
    })
    for (const seed of ['det-7', 'det-8', 'det-9']) {
      const a = playOut(seed, testEnv(realContent(), false))
      const b = playOut(seed, testEnv(extended, false))
      expect(kinds(b, 'hiccups').length).toBeGreaterThan(20)
      expect(deathMonth(b)).toBe(deathMonth(a))
      expect(kinds(b, 'illness_started')).toEqual(kinds(a, 'illness_started'))
      expect(kinds(b, 'milestone')).toEqual(kinds(a, 'milestone'))
    }
  })

  it('the same seed played two ways shares everything the choices did not touch', () => {
    // A paired counterfactual: one life, lived actively and lived sedentary.
    const env = testEnv(realContent(), false)
    let active = newLife('det-10', env)
    let idle = newLife('det-10', env)
    while (active.phase === 'alive') active = playYear(active, 'active', env)
    while (idle.phase === 'alive') idle = playYear(idle, 'sedentary', env)
    expect(deathMonth(active)).toBe(deathMonth(idle)) // mortality does not yet depend on lifestyle
    expect(kinds(active, 'illness_started')).toEqual(kinds(idle, 'illness_started'))
    expect(simulationHash(active)).not.toBe(simulationHash(idle))
  })
})
