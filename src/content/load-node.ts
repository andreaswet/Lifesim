/** Reads the `content/` directory from disk. Node only: used by tools, tests and the Vite plugin. */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileContent, type ContentFiles } from './compile'

export const CONTENT_DIR = fileURLToPath(new URL('../../content', import.meta.url))

export function readContentFiles(dir: string = CONTENT_DIR): ContentFiles {
  const files: ContentFiles = {}
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.yaml') || name.endsWith('.csv')) files[relative(dir, full).split(sep).join('/')] = readFileSync(full, 'utf8')
    }
  }
  walk(dir)
  return files
}

export function loadContent(dir: string = CONTENT_DIR) {
  return compileContent(readContentFiles(dir))
}
