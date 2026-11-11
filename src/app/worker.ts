/**
 * The game host. Runs in a Web Worker so the page never blocks: it owns the state, applies
 * commands with the engine, autosaves, and sends the interface only the player's view.
 */

import bundle from 'virtual:lifesim-content'
import { EngineError, SaveError, createLife, exportSave, importSave, perceive, prepareContent, step, type ContentBundleType, type EngineEnv, type GameState } from '../engine'
import { createNarrator, explainOutcome } from '../narrative'
import type { Envelope, Reply, Request } from './protocol'
import { clearAutosave, loadAutosave, storeAutosave } from './storage'

/**
 * Interactive lives skip the player character's own death draws before this age (see
 * StartOptions.protectPlayerUntilAge). Batch runs never do.
 */
const PROTECT_UNTIL_AGE = 5

const content = prepareContent(bundle as ContentBundleType)
const env: EngineEnv = { content, narrator: createNarrator() }
let state: GameState | null = null

const view = () => (state ? perceive(state, content) : null)

async function handle(request: Request): Promise<Reply> {
  switch (request.type) {
    case 'init': {
      const saved = await loadAutosave()
      if (saved) {
        try {
          state = importSave(saved)
        } catch {
          // An unreadable autosave is left in place rather than deleted; the player starts fresh
          // and the next save replaces it.
          state = null
        }
      }
      return { ok: true, view: view(), setup: { states: content.bundle.country.states.map((s) => ({ id: s.id, name: s.name })), groups: content.bundle.country.people.groups.map((g) => ({ id: g.id, label: g.label })) } }
    }
    case 'new': {
      const { seed, firstName, familyName, sex, state: birthState, ethnicity } = request.options
      state = createLife({ seed, start: { firstName, familyName, sex, state: birthState, ethnicity, protectPlayerUntilAge: PROTECT_UNTIL_AGE } }, env)
      await storeAutosave(exportSave(state))
      return { ok: true, view: view() }
    }
    case 'command': {
      if (!state) return { ok: false, error: 'There is no life in progress.' }
      state = step(state, request.command, env).state
      await storeAutosave(exportSave(state))
      return { ok: true, view: view() }
    }
    case 'explain':
      return { ok: true, view: view(), explanation: state ? explainOutcome(state, content, request.outcomeId) : null }
    case 'export':
      return state ? { ok: true, view: view(), saveText: exportSave(state) } : { ok: false, error: 'There is no life to save.' }
    case 'import': {
      state = importSave(request.text)
      await storeAutosave(exportSave(state))
      return { ok: true, view: view() }
    }
    case 'abandon':
      state = null
      await clearAutosave()
      return { ok: true, view: null }
  }
}

self.onmessage = (event: MessageEvent<Envelope<Request>>) => {
  const { id, ...request } = event.data
  handle(request as Request)
    .catch((error: unknown): Reply => {
      // Errors a player can cause (a bad save file, a stale choice) are reported in plain words;
      // anything else is a bug and says so.
      const expected = error instanceof SaveError || error instanceof EngineError
      return { ok: false, error: expected ? (error as Error).message : `Something went wrong inside the game: ${(error as Error).message}` }
    })
    .then((reply) => self.postMessage({ id, ...reply }))
}
