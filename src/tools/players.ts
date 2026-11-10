/**
 * Simple AI players for batch runs (design §13.1).
 *
 * `persona` is the calibration player: it behaves as its own drawn disposition would, which is
 * what a real population does, and it makes the same choices at the same rates as the people the
 * player does not control. The others push one strategy, to look for exploits and to check causal
 * gradients. Each player draws from its own random stream, so it never disturbs the life's own
 * luck: the same seed played two ways differs only through the choices made.
 */

import { autoChoice, leavingChances, perceive, step, type EngineEnv, type GameState } from '../engine'
import { KeyedRng } from '../engine/core/rng'
import { ageInYears } from '../engine/core/time'
import { player } from '../engine/state'

export const STRATEGIES = ['persona', 'active', 'sedentary', 'random', 'striver', 'drifter'] as const
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

function setPolicy(state: GameState, policy: { activity?: string; study?: string }, env: EngineEnv): GameState {
  const self = player(state)
  if ((policy.activity ?? self.policies.activity) === self.policies.activity && (policy.study ?? self.policies.study) === self.policies.study) return state
  return step(state, { type: 'setPolicy', policy }, env).state
}

function act(state: GameState, action: string, env: EngineEnv): GameState {
  return perceive(state, env.content).actions.some((a) => a.id === action && a.choices.length === 0) ? step(state, { type: 'act', action }, env).state : state
}

/** Plays one year: answers what is open, adjusts policy, advances to the next birthday. */
export function playYear(state: GameState, strategy: Strategy, env: EngineEnv): GameState {
  const rng = new KeyedRng(`${state.meta.seed}:player:${strategy}`)
  const age = ageInYears(player(state).born, state.now)
  const levels = env.content.bundle.body.activityLevels
  const study = env.content.bundle.country.education.k12.study
  const canMove = age >= env.content.bundle.body.activityChoiceFromAge
  const canStudy = age >= study.choiceFromAge

  for (const decision of state.decisions.filter((d) => d.subjectId === state.playerId)) {
    const ids = decision.options.map((o) => o.id)
    let optionId: string
    // In Milestone 1 content the first option is the effortful one; school decisions have no
    // such order, so strategies that do not care about school answer them in character.
    const isSchool = decision.source.startsWith('system:edu.')
    if (strategy === 'random') optionId = rng.pick(ids, 'option', decision.id)
    else if (strategy === 'active' && !isSchool) optionId = ids[0]!
    else if (strategy === 'sedentary' && !isSchool) optionId = ids[ids.length - 1]!
    else if (strategy === 'striver' && decision.source === 'system:edu.apply') optionId = ids[ids.length - 1]!
    else if (strategy === 'striver' && decision.source === 'system:edu.test') optionId = 'take'
    else if (strategy === 'striver' && decision.source === 'system:edu.choose') optionId = ids[0] === 'none' ? ids[0]! : ids[0]!
    else if (strategy === 'drifter' && decision.source === 'system:edu.apply') optionId = ids[0]!
    else optionId = autoChoice(state, decision, env)
    state = step(state, { type: 'decide', decisionId: decision.id, optionId }, env).state
  }

  if (canMove) {
    if (strategy === 'active') state = setPolicy(state, { activity: levels[levels.length - 1]!.id }, env)
    else if (strategy === 'sedentary' && age >= 18) state = setPolicy(state, { activity: levels[0]!.id }, env)
    else if (strategy === 'random' && rng.chance(0.05, 'drift', age)) state = setPolicy(state, { activity: rng.pick(levels, 'level', age).id }, env)
    else if ((strategy === 'persona' || strategy === 'striver' || strategy === 'drifter') && age === 18) {
      const index = rng.weighted(ADULT_ACTIVITY_SHARES.map(([, share]) => share), 'disposition')
      state = setPolicy(state, { activity: ADULT_ACTIVITY_SHARES[index]![0] }, env)
    }
  }

  if (canStudy) {
    const self = player(state)
    if (strategy === 'striver') state = setPolicy(state, { study: study.levels[study.levels.length - 1]!.id }, env)
    else if (strategy === 'drifter') state = setPolicy(state, { study: study.levels[0]!.id }, env)
    else if (strategy === 'random') {
      if (rng.chance(0.1, 'study', age)) state = setPolicy(state, { study: rng.pick(study.levels, 'studyLevel', age).id }, env)
    } else if (age === study.choiceFromAge) {
      // How hard a child works once it is theirs to decide follows their own temperament.
      const c = (self.traits.conscientiousness ?? 0) + 0.5 * rng.normal('studyDisposition')
      state = setPolicy(state, { study: c < -0.9 ? 'minimal' : c > 1.0 ? 'pushing' : 'steady' }, env)
    }
  }

  // Leaving school, leaving college and coming back for the equivalency are the player's own
  // acts. Players that are not pushing a schooling strategy take them at the rates other people do.
  if (strategy !== 'striver') {
    const chances = leavingChances(state, env.content, player(state))
    const push = strategy === 'drifter' ? 2 : 1
    if (rng.chance(Math.min(1, chances.school * push), 'leaveSchool', age)) state = act(state, 'edu.leave_school', env)
    else if (rng.chance(Math.min(1, chances.college * push), 'leaveCollege', age)) state = act(state, 'edu.leave_school', env)
    if (rng.chance(chances.equivalency, 'equivalency', age)) state = act(state, 'edu.equivalency', env)
    // Going to college later, or going back.
    if (rng.chance(chances.enroll, 'enroll', age)) state = act(state, rng.chance(chances.enrollAtCommunity, 'enrollWhere', age) ? 'edu.enroll_community' : 'edu.apply', env)
  } else {
    const self = player(state)
    if (self.education.status === 'left_k12') state = act(state, 'edu.equivalency', env)
    else state = act(state, 'edu.apply', env)
  }

  return step(state, { type: 'advance', until: 'birthday' }, env).state
}
