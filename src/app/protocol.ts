/**
 * Messages between the interface and the worker that runs the engine (design §4.2).
 *
 * This file is the whole of what the interface knows about the game: the player's view, the
 * commands, and explanations. Only types are imported here, so nothing of the engine's internals
 * is bundled into, or reachable from, the interface.
 */

import type { Command } from '../engine/state'
import type { PlayerView } from '../engine/view'
import type { Explanation } from '../narrative/why'

export type { Command, PlayerView, Explanation }
export type { ActionView, DecisionView, FamilyMember, FeedItem, MoneyView, PolicyView, SchoolView, WorkView } from '../engine/view'

export interface NewLifeOptions {
  seed: string
  firstName?: string
  familyName?: string
  sex?: 'male' | 'female'
  /** State id to be born in. */
  state?: string
  /** Group id (design decision Q1). */
  ethnicity?: string
}

/** What the start screen needs to offer its choices. */
export interface Setup {
  states: Array<{ id: string; name: string }>
  groups: Array<{ id: string; label: string }>
}

export type Request =
  | { type: 'init' }
  | { type: 'new'; options: NewLifeOptions }
  | { type: 'command'; command: Command }
  | { type: 'explain'; outcomeId: string }
  | { type: 'export' }
  | { type: 'import'; text: string }
  | { type: 'abandon' }

export type Reply =
  | { ok: true; view: PlayerView | null; explanation?: Explanation | null; saveText?: string; setup?: Setup }
  | { ok: false; error: string }

export type Envelope<T> = T & { id: number }
