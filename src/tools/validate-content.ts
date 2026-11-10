/** Compiles and validates the content directory. Exits non-zero and lists every problem on failure. */

import { ContentError } from '../content/compile'
import { loadContent } from '../content/load-node'

try {
  const bundle = loadContent()
  console.log(`Content is valid. hash ${bundle.hash}`)
  console.log(`  ${bundle.events.length} events, ${bundle.processes.length} processes, ${bundle.text.length} texts (${bundle.text.reduce((n, t) => n + t.variants.length, 0)} variants), ${bundle.factors.length} factors`)
} catch (error) {
  if (error instanceof ContentError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}
