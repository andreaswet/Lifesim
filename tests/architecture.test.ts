import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

/** Every module a file imports: the top-level folder under src for relative imports, else the package name. */
function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const found: string[] = []
  for (const match of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    const spec = match[1]!
    if (spec.startsWith('.')) found.push('src/' + relative(SRC, resolve(dirname(file), spec)).split(/[\\/]/)[0])
    else found.push(spec)
  }
  return found
}

const allowed: Record<string, RegExp> = {
  // The engine is headless and self-contained (design §4.1).
  engine: /^(src\/engine|zod)$/,
  narrative: /^(src\/engine|src\/narrative)$/,
  content: /^(src\/engine|src\/content|zod|yaml|node:.*)$/,
  // The interface sees the player's view and nothing behind it.
  ui: /^(src\/ui|src\/app|preact.*)$/,
}

describe('architecture', () => {
  for (const [folder, pattern] of Object.entries(allowed)) {
    it(`src/${folder} imports only what it is allowed to`, () => {
      for (const file of sources(join(SRC, folder))) {
        for (const spec of imports(file)) expect(spec, `${relative(SRC, file)} imports ${spec}`).toMatch(pattern)
      }
    })
  }

  it('the interface reaches the engine only through the app protocol', () => {
    for (const file of sources(join(SRC, 'ui'))) {
      for (const spec of imports(file)) if (spec === 'src/app') expect(readFileSync(file, 'utf8')).toMatch(/from '\.\.\/app\/(protocol|client)'/)
    }
  })

  it('the simulation never reads the clock, the DOM or an unseeded random number', () => {
    for (const folder of ['engine', 'narrative']) {
      for (const file of sources(join(SRC, folder))) {
        const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
        for (const banned of ['Math.random', 'Date.now', 'new Date', 'performance.now', 'window.', 'document.', 'localStorage', 'Math.exp(', 'Math.log(', 'Math.pow(', 'Math.sin(', 'Math.cos(']) {
          expect(text.includes(banned), `${relative(SRC, file)} uses ${banned}`).toBe(false)
        }
      }
    }
  })
})
