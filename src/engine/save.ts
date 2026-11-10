/**
 * Save files (design §4.6): JSON with a schema version and a chain of migrations, so updates do
 * not break old saves. A migration takes the whole save's state at version N and returns it at
 * version N + 1. Every migration is tested against a stored save from its source version.
 */

import { hashString } from './core/rng'
import { ENGINE_VERSION, GameState, SCHEMA_VERSION } from './state'

export const SAVE_FORMAT = 'lifesim-save'

export class SaveError extends Error {}

export type Migration = (state: Record<string, unknown>) => Record<string, unknown>

/** Keyed by the version migrated *from*. Empty while there is only one version. */
export const MIGRATIONS: Record<number, Migration> = {}

export function exportSave(state: GameState): string {
  return JSON.stringify({ format: SAVE_FORMAT, schemaVersion: state.meta.schemaVersion, savedWith: ENGINE_VERSION, state })
}

export function importSave(text: string, options: { migrations?: Record<number, Migration>; targetVersion?: number } = {}): GameState {
  const migrations = options.migrations ?? MIGRATIONS
  const target = options.targetVersion ?? SCHEMA_VERSION

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SaveError('This file is not a Lifesim save: it is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { format?: unknown }).format !== SAVE_FORMAT) {
    throw new SaveError('This file is not a Lifesim save.')
  }
  const file = parsed as { schemaVersion?: unknown; state?: unknown }
  if (typeof file.schemaVersion !== 'number' || typeof file.state !== 'object' || file.state === null) {
    throw new SaveError('This save file is damaged: it has no version or no state.')
  }
  if (file.schemaVersion > target) {
    throw new SaveError(`This save comes from a newer version of the game (save format ${file.schemaVersion}; this build reads up to ${target}).`)
  }

  let version = file.schemaVersion
  let state = file.state as Record<string, unknown>
  while (version < target) {
    const migrate = migrations[version]
    if (!migrate) throw new SaveError(`This save is too old to load: there is no upgrade path from save format ${version}.`)
    state = migrate(state)
    version += 1
  }

  const result = GameState.safeParse(state)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new SaveError(`This save file is damaged (${first ? `${first.path.join('.')}: ${first.message}` : 'unknown problem'}).`)
  }
  return result.data
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) out[key] = stable((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** Hash of the whole state, independent of key order. */
export function stateHash(state: GameState): string {
  return hashString(JSON.stringify(stable(state)))
}

/**
 * Hash of the simulation only: prose and the narrator's bookkeeping are left out. Two runs that
 * differ only in wording have the same simulation hash.
 */
export function simulationHash(state: GameState): string {
  const { narration: _narration, log, ...rest } = state
  const bareLog = log.map(({ text: _text, templateId: _templateId, ...entry }) => entry)
  const decisions = state.decisions.map(({ prompt: _prompt, ...d }) => d)
  return hashString(JSON.stringify(stable({ ...rest, decisions, log: bareLog })))
}
