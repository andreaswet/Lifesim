/**
 * Replays a save file from its seed and command log and checks that the result matches the saved
 * state (design §4.3).
 *
 *   npm run replay -- path/to/save.json
 *
 * A mismatch means the engine or the content changed since the save was written, or that
 * determinism is broken. The first is expected across versions; the second is a bug.
 */

import { readFileSync } from 'node:fs'
import { loadContent } from '../content/load-node'
import { importSave, prepareContent, replay, simulationHash } from '../engine'

const path = process.argv[2]
if (!path) {
  console.error('Usage: npm run replay -- <save file>')
  process.exit(2)
}

const saved = importSave(readFileSync(path, 'utf8'))
const content = prepareContent(loadContent())
const rebuilt = replay({ seed: saved.meta.seed, options: saved.meta.options, commands: saved.meta.commandLog }, { content, narrator: null })

// The recorded content hash follows the content in use, so it is left out of the comparison.
const hash = (state: typeof saved): string => simulationHash({ ...state, meta: { ...state.meta, contentHash: '' } })
const same = hash(rebuilt) === hash(saved)
console.log(`Seed "${saved.meta.seed}", ${saved.meta.commandLog.length} commands, ${saved.log.length} log entries.`)
console.log(`Saved with content ${saved.meta.contentHash}; replayed with content ${content.bundle.hash}.`)
console.log(same ? 'Replay matches the save exactly.' : 'Replay DIFFERS from the save.')
process.exit(same ? 0 : 1)
