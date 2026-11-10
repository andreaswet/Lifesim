import { compileContent, type ContentFiles } from '../src/content/compile'
import { readContentFiles } from '../src/content/load-node'
import { autoChoice, createLife, prepareContent, step, type EngineEnv, type GameState, type Prepared } from '../src/engine'
import { createNarrator } from '../src/narrative'

let files: ContentFiles | null = null
let real: Prepared | null = null

export function realFiles(): ContentFiles {
  return { ...(files ??= readContentFiles()) }
}

/** The shipped content, compiled once. */
export function realContent(): Prepared {
  return (real ??= prepareContent(compileContent(realFiles())))
}

/**
 * The shipped content with some files replaced, added (path → text) or removed (path → null).
 * Tests use this to supply their own events and processes, which also proves that new content
 * needs no engine change.
 */
export function contentWith(changes: Record<string, string | null>): Prepared {
  const merged = realFiles()
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) delete merged[path]
    else merged[path] = text
  }
  return prepareContent(compileContent(merged))
}

/** Removes every shipped event and process, leaving the body, mortality and text. */
export const NO_EVENTS: Record<string, string | null> = {
  'core/events/life.yaml': null,
  'core/events/health.yaml': null,
  'core/events/activity.yaml': null,
  'core/processes/flu.yaml': null,
}

/** Text for the fact kinds that only the removed shipped events emit would fail validation, so drop it too. */
export const NO_EVENT_TEXT: Record<string, string | null> = {
  'core/text/life.yaml': `
- id: life.birth
  fact: birth
  variants: [{ text: "Born." }]
- id: life.death
  fact: death
  variants: [{ text: "Died at {fact.age}." }]
`,
  'core/text/health.yaml': `
- id: health.band
  fact: band_changed
  variants: [{ text: "{fact.descriptor} is now {fact.to}." }]
`,
  'core/text/activity.yaml': `
- id: activity.changed
  fact: activity_changed
  variants: [{ text: "Activity is now {fact.to}." }]
- id: decision.made
  fact: decision_made
  variants: [{ text: "Chose {fact.choice}." }]
`,
}

export function bareContent(extra: Record<string, string | null> = {}): Prepared {
  return contentWith({ ...NO_EVENTS, ...NO_EVENT_TEXT, ...extra })
}

export function testEnv(content: Prepared = realContent(), narrated = true): EngineEnv {
  return { content, narrator: narrated ? createNarrator() : null, detectDuplicateDraws: true }
}

/** Advances birthday by birthday, letting the character answer anything that comes up. */
export function liveUntil(state: GameState, env: EngineEnv, stop: (s: GameState) => boolean, maxYears = 130): GameState {
  for (let i = 0; i < maxYears && state.phase === 'alive' && !stop(state); i++) {
    for (const d of state.decisions) state = step(state, { type: 'decide', decisionId: d.id, optionId: autoChoice(state, d, env) }, env).state
    state = step(state, { type: 'advance', until: 'birthday' }, env).state
  }
  return state
}

export function newLife(seed: string, env: EngineEnv, protect = 0): GameState {
  return createLife({ seed, start: { protectPlayerUntilAge: protect } }, env)
}

export function ageOf(state: GameState): number {
  const p = state.people[state.playerId]!
  return Math.floor(((p.died?.at ?? state.now) - p.born) / 12)
}
