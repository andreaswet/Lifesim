/**
 * Simple AI players for batch runs (design §13.1).
 *
 * `persona` is the calibration player: it behaves as its own drawn disposition would, which is
 * what a real population does. The others push one strategy, to look for exploits and to check
 * causal gradients. Each player draws from its own random stream, so it never disturbs the life's
 * own luck: the same seed played two ways differs only through the choices made.
 */

import { autoChoice, step, type EngineEnv, type GameState } from '../engine'
import { KeyedRng } from '../engine/core/rng'
import { ageInYears } from '../engine/core/time'
import { player } from '../engine/state'

export const STRATEGIES = ['persona', 'active', 'sedentary', 'random'] as const
export type Strategy = (typeof STRATEGIES)[number]

/**
 * Share of US adults at each activity level, roughly: about a quarter report no leisure-time
 * physical activity, and about a quarter meet both aerobic and strength guidelines
 * (CDC NHIS 2020–2022). Used only to give persona players varied dispositions.
 */
const ADULT_ACTIVITY_SHARES: Array<[string, number]> = [
  ['sedentary', 0.26],
  ['light', 0.28],
  ['moderate', 0.3],
  ['active', 0.16],
]

function setActivity(state: GameState, activity: string, env: EngineEnv): GameState {
  if (player(state).policies.activity === activity) return state
  return step(state, { type: 'setPolicy', policy: { activity } }, env).state
}

/** Plays one year: answers what is open, adjusts policy, advances to the next birthday. */
export function playYear(state: GameState, strategy: Strategy, env: EngineEnv): GameState {
  const rng = new KeyedRng(`${state.meta.seed}:player:${strategy}`)
  const self = player(state)
  const age = ageInYears(self.born, state.now)
  const levels = env.content.bundle.body.activityLevels
  const canChoose = age >= env.content.bundle.body.activityChoiceFromAge

  for (const decision of state.decisions.filter((d) => d.subjectId === state.playerId)) {
    const ids = decision.options.map((o) => o.id)
    let optionId: string
    if (strategy === 'active') optionId = ids[0]!
    else if (strategy === 'sedentary') optionId = ids[ids.length - 1]!
    else if (strategy === 'random') optionId = rng.pick(ids, 'option', decision.id)
    else optionId = autoChoice(state, decision, env)
    // By convention in Milestone 1 content the first option is the effortful one. "sedentary"
    // still keeps an existing routine rather than dropping it only where dropping is the last option.
    state = step(state, { type: 'decide', decisionId: decision.id, optionId }, env).state
  }

  if (canChoose) {
    if (strategy === 'active') state = setActivity(state, levels[levels.length - 1]!.id, env)
    else if (strategy === 'sedentary' && age >= 18) state = setActivity(state, levels[0]!.id, env)
    else if (strategy === 'random' && rng.chance(0.05, 'drift', age)) state = setActivity(state, rng.pick(levels, 'level', age).id, env)
    else if (strategy === 'persona' && age === 18) {
      const index = rng.weighted(ADULT_ACTIVITY_SHARES.map(([, share]) => share), 'disposition')
      state = setActivity(state, ADULT_ACTIVITY_SHARES[index]![0], env)
    }
  }

  return step(state, { type: 'advance', until: 'birthday' }, env).state
}
