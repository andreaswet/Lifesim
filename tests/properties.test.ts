import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { checkInvariants, exportSave, importSave, perceive, step, type GameState } from '../src/engine'
import type { Command } from '../src/engine/state'
import { newLife, realContent, testEnv } from './helpers'

/** An intention that is turned into a valid command for whatever state the life is in. */
const intent = fc.oneof(
  { weight: 5, arbitrary: fc.constant({ kind: 'birthday' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'season' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'month' as const }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('decide' as const), pick: fc.nat(7) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('policy' as const), pick: fc.nat(7) }) },
)

describe('properties', () => {
  it('no sequence of valid commands breaks an invariant, throws, or fails to save and reload', () => {
    const content = realContent()
    const env = testEnv(content)
    const levels = content.bundle.body.activityLevels
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), fc.array(intent, { minLength: 5, maxLength: 140 }), (seed, intents) => {
        let state: GameState = newLife(seed, env)
        for (const it of intents) {
          let command: Command | null = null
          if (it.kind === 'decide') {
            const open = state.decisions[0]
            if (open) command = { type: 'decide', decisionId: open.id, optionId: open.options[it.pick % open.options.length]!.id }
          } else if (it.kind === 'policy') {
            if (perceive(state, content).routine.activity.canChange) command = { type: 'setPolicy', policy: { activity: levels[it.pick % levels.length]!.id } }
          } else {
            command = { type: 'advance', until: it.kind }
          }
          if (!command) continue
          state = step(state, command, env).state
          expect(checkInvariants(state, content)).toEqual([])
        }
        expect(importSave(exportSave(state))).toEqual(state)
        // The view can always be built, and never offers an advance the engine would refuse.
        const view = perceive(state, content)
        expect(view.advance.allowed).toBe(state.phase === 'alive' && !state.decisions.some((d) => d.class === 'blocking'))
      }),
      { numRuns: 60 },
    )
  })
})
