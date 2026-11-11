/**
 * Builds one validated content bundle from the authored files (design §12.1).
 *
 * Input is a map of relative path → file text, so the same code serves the Node tools (which read
 * the `content/` directory) and the Vite plugin (which does the same at build time). Nothing here
 * touches the file system.
 */

import { parse as parseYaml } from 'yaml'
import type { z } from 'zod'
import { hashString } from '../engine/core/rng'
import { ContentBundle, FileSchemas, type ContentBundleInput } from '../engine/content/schema'
import { validateContent } from '../engine/content/validate'

export class ContentError extends Error {
  constructor(readonly problems: string[]) {
    super(`Content has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n  - ${problems.join('\n  - ')}`)
  }
}

export type ContentFiles = Record<string, string>

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.startsWith('#'))
  const header = (lines.shift() ?? '').split(',').map((h) => h.trim())
  return lines.map((line) => {
    const cells = line.split(',')
    const row: Record<string, string> = {}
    header.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim()
    })
    return row
  })
}

export function compileContent(files: ContentFiles, countryId = 'us'): ContentBundle {
  const problems: string[] = []

  function read<S extends z.ZodType>(path: string, schema: S): z.output<S> | undefined {
    const text = files[path]
    if (text === undefined) {
      problems.push(`${path}: file is missing`)
      return undefined
    }
    let raw: unknown
    try {
      raw = parseYaml(text)
    } catch (error) {
      problems.push(`${path}: ${(error as Error).message}`)
      return undefined
    }
    const result = schema.safeParse(raw)
    if (!result.success) {
      for (const issue of result.error.issues) problems.push(`${path}: ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      return undefined
    }
    return result.data
  }

  /** Every YAML file under any of the given folders, each holding a list, concatenated in path order. */
  function readAll<S extends z.ZodType<unknown[]>>(folders: string[], schema: S): z.output<S> {
    const out: unknown[] = []
    const paths = Object.keys(files)
      .filter((p) => p.endsWith('.yaml') && folders.some((f) => p.startsWith(f + '/')))
      .sort()
    for (const path of paths) {
      const part = read(path, schema)
      if (part) out.push(...part)
    }
    return out as z.output<S>
  }

  const country = `countries/${countryId}`
  const stages = read('core/stages.yaml', FileSchemas.stages)
  const body = read('core/body.yaml', FileSchemas.body)
  const descriptors = read('core/descriptors.yaml', FileSchemas.descriptors)
  const factors = read('core/factors.yaml', FileSchemas.factors)
  const pacing = read('core/pacing.yaml', FileSchemas.pacing)
  const events = readAll(['core/events', `${country}/events`], FileSchemas.events)
  const processes = readAll(['core/processes', `${country}/processes`], FileSchemas.processes)
  const text = readAll(['core/text', `${country}/text`], FileSchemas.text)
  const countryDef = read(`${country}/country.yaml`, FileSchemas.country)
  const tableMeta = read(`${country}/demographics/life-table.yaml`, FileSchemas.lifeTableMeta)
  const names = read(`${country}/demographics/names.yaml`, FileSchemas.names)
  const family = read(`${country}/demographics/family.yaml`, FileSchemas.family)
  const people = read(`${country}/demographics/people.yaml`, FileSchemas.people)
  const economy = read(`${country}/economy/economy.yaml`, FileSchemas.economy)
  const market = read(`${country}/labor/market.yaml`, FileSchemas.labor)
  const occupations = read(`${country}/labor/occupations.yaml`, FileSchemas.occupations)
  const tax = read(`${country}/tax/federal.yaml`, FileSchemas.tax)
  const money = read(`${country}/money/household.yaml`, FileSchemas.money)
  const education = read(`${country}/education/system.yaml`, FileSchemas.education)
  const norms = read(`${country}/education/norms.yaml`, FileSchemas.norms)
  const schools = read(`${country}/education/schools.yaml`, FileSchemas.schools)

  const statesPath = `${country}/places/states.csv`
  const states: Array<Record<string, string | number | boolean>> = []
  if (files[statesPath] === undefined) problems.push(`${statesPath}: file is missing`)
  else {
    for (const row of parseCsv(files[statesPath])) {
      const state: Record<string, string | number | boolean> = { id: row.id ?? '', name: row.name ?? '' }
      for (const column of ['population', 'rpp', 'rent', 'home', 'incomeTax', 'propertyTax', 'minWage', 'uiMax']) state[column] = Number(row[column])
      state.medicaid = row.medicaid === '1'
      states.push(state)
    }
  }

  const tablePath = `${country}/demographics/life-table.csv`
  const male: number[] = []
  const female: number[] = []
  if (files[tablePath] === undefined) {
    problems.push(`${tablePath}: file is missing`)
  } else {
    parseCsv(files[tablePath]).forEach((row, i) => {
      if (Number(row.age) !== i) problems.push(`${tablePath}: row ${i + 1} should be age ${i}`)
      male.push(Number(row.qx_male))
      female.push(Number(row.qx_female))
    })
  }

  if (problems.length > 0 || !stages || !body || !descriptors || !factors || !pacing || !countryDef || !tableMeta || !names || !family || !people || !economy || !market || !occupations || !tax || !money || !education || !norms || !schools) {
    throw new ContentError(problems)
  }

  const draft = {
    schemaVersion: 1 as const,
    hash: '',
    stages,
    body,
    descriptors,
    factors,
    pacing,
    events,
    processes,
    text,
    country: { ...countryDef, lifeTable: { ...tableMeta, male, female }, names, states, family, people, economy, labor: { ...market, occupations }, tax, money, education, norms, schools },
  }
  // Parsing the assembled draft once more checks the life table and gives the engine one object
  // that is known to match the bundle schema exactly.
  const parsed = ContentBundle.safeParse(draft as unknown as ContentBundleInput)
  if (!parsed.success) throw new ContentError(parsed.error.issues.map((i) => `bundle: ${i.path.join('.')}: ${i.message}`))

  const semantic = validateContent(parsed.data)
  if (semantic.length > 0) throw new ContentError(semantic)

  parsed.data.hash = hashString(JSON.stringify({ ...parsed.data, hash: '' }))
  return parsed.data
}
