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

type Loose = Record<string, unknown>

/**
 * Version 1 → 2 (Milestone 2). Families, households, inherited traits and schooling were added.
 * A version 1 life has none of these and they cannot be invented after the fact, so the person
 * is carried over as someone whose family is unknown and whose schooling is not modeled: they
 * keep their body, their history and their log, and can be played on to the end.
 */
function migrate1to2(state: Loose): Loose {
  const people = state.people as Record<string, Loose>
  const now = state.now as number
  for (const person of Object.values(people)) {
    const adult = (now - (person.born as number)) / 12 >= 18
    Object.assign(person, {
      motherId: null,
      fatherId: null,
      partner: null,
      householdId: person.died ? null : 'h1',
      genes: {},
      aptitudes: {},
      traits: {},
      skills: {},
      strain: 0,
      policies: { ...(person.policies as Loose), study: 'steady' },
      education: {
        status: 'not_modeled',
        level: adult ? 'high_school' : 'less_than_hs',
        grade: null,
        school: null,
        courseLevel: 'regular',
        lastReport: null,
        hs: { gpaSum: 0, years: 0, rigorSum: 0 },
        standing: 0,
        test: null,
        disengagement: 0,
        applications: [],
        plan: null,
        college: null,
        loans: 0,
      },
      work: null,
      nextBirth: null,
    })
  }
  const living = Object.values(people).filter((p) => !p.died).map((p) => p.id as string)
  const decisions = (state.decisions as Loose[]).map(({ eventId, ...rest }) => ({ ...rest, source: `event:${String(eventId)}`, optional: true }))
  return {
    ...state,
    people,
    decisions,
    households: {
      h1: { id: 'h1', members: living, state: 'unknown', neighborhood: 3, income: 0, disruption: 0, collegeWillingness: 1, schools: { elementary: '', middle: '', high: '', quality: 0 } },
    },
    meta: { ...(state.meta as Loose), schemaVersion: 2 },
  }
}

/**
 * Version 2 → 3 (Milestone 3). The economy, employers, jobs, accounts, housing and ethnicity were
 * added. A version 2 life had none of them: parents had a stand-in for earnings and nobody held
 * any money. The economy starts from an ordinary month; working parents are given a job that
 * pays what their stand-in did; every household rents; and accounts start empty. Nothing that
 * was lived is changed, and the life can be played on.
 */
function migrate2to3(state: Loose): Loose {
  const people = state.people as Record<string, Loose>
  const households = state.households as Record<string, Loose>
  const now = state.now as number
  const orgs: Record<string, Loose> = {}
  // Ids that exist in every content version from 3 on; later renames go through the alias table.
  const byLevel: Record<string, string> = { less_than_hs: 'warehouse_worker', high_school: 'administrative_assistant', some_college: 'customer_service_rep', associate: 'it_support', bachelor: 'marketing_specialist', graduate: 'business_manager' }
  let nextId = state.nextId as number
  for (const person of Object.values(people)) {
    const old = person.work as { earnings: number; hours: string; employed: boolean; unemployedSince: number | null } | null
    const education = person.education as Loose
    const age = (now - (person.born as number)) / 12
    let work: Loose | null = null
    if (old) {
      const occupation = byLevel[education.level as string] ?? 'warehouse_worker'
      const working = old.employed && old.hours !== 'none' && age < 66 && !person.died
      const hours = old.hours === 'part' ? 22 : 40
      let job: Loose | null = null
      if (working) {
        const orgId = `org${nextId++}`
        orgs[orgId] = { id: orgId, name: 'Meridian Group', sector: 'business', pay: 1, health: 'sound', since: now, until: now, risk: 0.03 }
        job = { occupation, level: 1, orgId, employer: 'Meridian Group', manager: 'Ms. Grant', started: now - 36, hoursPerWeek: hours, salary: Math.round(old.earnings * (old.hours === 'part' ? 0.5 : 1)), insured: hours >= 30, match: 0.03, pension: false, payIndex: 1, performance: 0.5, warned: false }
      }
      work = {
        status: job ? 'employed' : age >= 66 ? 'retired' : old.hours === 'none' ? 'home' : 'unemployed',
        job,
        skills: { [occupation]: 0.5 },
        months: { [occupation]: 120 },
        history: [],
        since: job ? null : (old.unemployedSince ?? now),
        laidOff: false,
        insurance: null,
        target: null,
        offer: null,
        payLevel: 0,
        earnings: new Array(Math.max(0, Math.min(35, Math.round(age - 22)))).fill(Math.round(old.earnings * 0.8)),
        yearWages: 0,
        benefit: age >= 66 ? { claimedAt: now, monthly: Math.round(old.earnings * 0.03) } : null,
        pension: 0,
        pensionYears: 0,
      }
    }
    Object.assign(person, {
      ethnicity: 'other',
      credentials: [],
      work,
      money: age >= 18 ? { credit: { history: 0.7, marks: [], opened: old ? now - 60 : null, evicted: null }, tax: { wages: 0, other: 0, withheld: 0 }, taxDue: null, missed: 0, hardship: 0, cover: 'none', student: null } : null,
      policies: { ...(person.policies as Loose), effort: 'steady', search: old && old.hours === 'none' ? 'none' : 'open', lifestyle: 'comfortable', saving: 'match' },
      education: { ...education, program: null },
      flags: { ...(person.flags as Loose), 'money.set': true, ...(old ? { 'work.situation': 'free' } : {}), ...(old && old.hours === 'none' ? { 'work.home': true } : {}), ...(old && old.hours === 'part' ? { 'work.partTime': true } : {}) },
    })
  }
  // What was owed on student loans before accounts existed becomes a balance with a lender.
  const accounts: Record<string, number> = {}
  for (const person of Object.values(people)) {
    const loans = Math.round(((person.education as Loose).loans as number) * 100)
    if (loans > 0 && !person.died) {
      accounts[`${String(person.id)}:student`] = -loans
      accounts['world:colleges'] = (accounts['world:colleges'] ?? 0) + loans
    }
  }
  for (const home of Object.values(households)) {
    const members = (home.members as string[]).map((id) => people[id]!).filter((p) => p && (now - (p.born as number)) / 12 >= 18)
    const payer = members.sort((a, b) => (a.born as number) - (b.born as number))[0]
    const partner = payer?.partner as { id: string } | null | undefined
    const head = payer && partner && members.some((m) => m.id === partner.id) && partner.id < (payer.id as string) ? partner.id : (payer?.id as string | undefined)
    home.housing = head ? { tenure: 'rent', payer: head, rent: 1400, rentSet: now, arrears: 0, mortgage: null, shared: false } : { tenure: 'guest', payer: null, rent: 0, rentSet: now, arrears: 0, mortgage: null, shared: false }
  }
  const sectors: Record<string, Loose> = {}
  for (const id of ['retail', 'hospitality', 'transport', 'services', 'health', 'construction', 'manufacturing', 'business', 'finance', 'tech', 'public', 'education', 'media', 'agriculture']) sectors[id] = { index: 1, trend: 0 }
  return {
    ...state,
    people,
    households,
    orgs,
    accounts,
    nextId,
    world: { regime: 'expansion', regimeSince: now - 24, recessions: 0, unemployment: 4.6, inflation: 2.6, spike: 0, priceLevel: 1, wageIndex: 1, policyRate: 3.4, mortgageRate: 6.2, stockIndex: 1, bondIndex: 1, housingIndex: 1, housingGrowth: 1.6, stockReturn: 0, bondReturn: 0, housingReturn: 0, sectors },
    meta: { ...(state.meta as Loose), schemaVersion: 3 },
  }
}

/** Keyed by the version migrated *from*. */
export const MIGRATIONS: Record<number, Migration> = { 1: migrate1to2, 2: migrate2to3 }

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
