/**
 * Actions: things the player starts themselves rather than answers (design §2.2). A system
 * registers an action with a test for when it is available; the player's view lists the ones
 * that are, and the `act` command performs one.
 *
 * Hooks are the same idea for content: a named piece of engine logic that a data-defined effect
 * can call (`run: <hook>`), used where an outcome needs the engine's models, such as sitting a test.
 */

import type { Ctx } from '../context'
import type { Prepared } from '../content/prepare'
import type { GameState, Person } from '../state'

export interface ActionOffer {
  label: string
  section: string
  costs?: string[]
  /** When present, the action needs one of these to be picked. */
  choices?: Array<{ id: string; label: string }>
}

export interface Action {
  available(state: GameState, content: Prepared, person: Person): ActionOffer | null
  perform(ctx: Ctx, person: Person, choice: string | undefined): void
}

const ACTIONS: Record<string, Action> = {}
const HOOKS: Record<string, (ctx: Ctx, subject: Person) => void> = {}

export function registerAction(id: string, action: Action): void {
  ACTIONS[id] = action
}

export function actionById(id: string): Action | undefined {
  return ACTIONS[id]
}

export function availableActions(state: GameState, content: Prepared, person: Person): Array<ActionOffer & { id: string }> {
  const out: Array<ActionOffer & { id: string }> = []
  for (const id of Object.keys(ACTIONS).sort()) {
    const offer = ACTIONS[id]!.available(state, content, person)
    if (offer) out.push({ id, ...offer })
  }
  return out
}

export function registerHook(id: string, hook: (ctx: Ctx, subject: Person) => void): void {
  HOOKS[id] = hook
}

export function hookNames(): string[] {
  return Object.keys(HOOKS)
}

export function runHook(ctx: Ctx, id: string, subject: Person): void {
  const hook = HOOKS[id]
  if (!hook) throw new Error(`Unknown hook '${id}'`)
  hook(ctx, subject)
}
