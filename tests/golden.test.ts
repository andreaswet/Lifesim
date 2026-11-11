import { describe, expect, it } from 'vitest'
import { checkInvariants, netWorth, simulationHash, type GameState } from '../src/engine'
import { playYear, type Strategy } from '../src/tools/players'
import { newLife, realContent, testEnv } from './helpers'

/**
 * Regression lives (design §14). Each is a seed played by a fixed strategy; the snapshot records
 * how the life went. A change here means the simulation's behaviour changed: if that was intended
 * (new content, a rebalanced rate), update the snapshot with `vitest -u` and say why in the commit.
 */
const GOLDEN: Array<[string, Strategy]> = [
  ['golden-ada', 'persona'],
  ['golden-ben', 'active'],
  ['golden-cyd', 'sedentary'],
  ['golden-dot', 'random'],
]

function summary(s: GameState) {
  const self = s.people.p1!
  const count = (kind: string): number => s.log.filter((e) => e.fact.kind === kind).length
  return {
    name: `${self.name.first} ${self.name.family}`,
    sex: self.sex,
    born: self.born,
    died: self.died!.at,
    ageAtDeath: Math.floor((self.died!.at - self.born) / 12),
    commands: s.meta.commandLog.length,
    logEntries: s.log.length,
    flu: count('illness_started'),
    decisions: count('decision_opened'),
    bandChanges: count('band_changed'),
    finalActivity: self.policies.activity,
    jobs: (self.work?.history.length ?? 0) + (self.work?.job ? 1 : 0),
    occupation: self.work?.history.at(-1)?.occupation ?? null,
    estateIn2026Dollars: Math.round(netWorth(s, 'p1') / s.world.priceLevel),
    recessions: s.world.recessions,
    cardio: Number(self.body.cardio.toFixed(6)),
    simulation: simulationHash({ ...s, meta: { ...s.meta, contentHash: '' } }),
  }
}

describe('golden lives', () => {
  for (const [seed, strategy] of GOLDEN) {
    it(`${seed} (${strategy})`, () => {
      const env = testEnv(realContent(), false)
      let s = newLife(seed, env)
      while (s.phase === 'alive') s = playYear(s, strategy, env)
      expect(checkInvariants(s, realContent())).toEqual([])
      expect(summary(s)).toMatchSnapshot()
    })
  }
})
