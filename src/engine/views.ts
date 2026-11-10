/**
 * Accessors: the only way content reads state (design §12.2).
 *
 * `ACCESSOR_PATHS` and `FUNCTION_NAMES` are the declared surface; the content validator checks
 * every expression against them at build time. `makeEnv` builds the matching values for one
 * person at one moment.
 */

import type { Env } from './core/expr'
import { clamp } from './core/dmath'
import { ageInYears, monthOf, seasonOf, yearOf, MONTH_NAMES } from './core/time'
import type { Prepared } from './content/prepare'
import { involvement } from './country/us/family'
import { parentsAtHome, relationOf, siblingsOf } from './people'
import type { GameState, Person, ProcessInstance, Scalar } from './state'

/** Paths content may read. A trailing `.*` allows any name beneath. */
export const ACCESSOR_PATHS: Record<'base' | 'process' | 'fact', string[]> = {
  base: [
    'self.age',
    'self.ageMonths',
    'self.sex',
    'self.stage',
    'self.cardio',
    'self.strength',
    'self.fitness',
    'self.activity',
    'self.activityLevel',
    'self.isPlayer',
    'self.first',
    'self.family',
    'self.name',
    'self.flag.*',
    'self.trait.*',
    'self.schooling',
    'self.grade',
    'self.study',
    'self.olderSiblings',
    'self.siblings',
    'home.*',
    'mother.*',
    'father.*',
    'who.*',
    'stays.*',
    'world.month',
    'world.monthName',
    'world.year',
    'world.season',
  ],
  process: ['process.stage', 'process.monthsInStage', 'process.months'],
  fact: ['fact.*'],
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const ORDINAL_WORDS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']

export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n]! : String(n)
}

export function ordinalWord(n: number): string {
  if (Number.isInteger(n) && n >= 0 && n < ORDINAL_WORDS.length) return ORDINAL_WORDS[n]!
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

/** A length of time in words: "three months", "a year", "two and a half years". */
export function spanWords(months: number): string {
  const m = Math.round(months)
  if (m < 1) return 'a few weeks'
  if (m === 1) return 'a month'
  if (m < 12) return `${numberWord(m)} months`
  const years = Math.floor(m / 12)
  const rest = m % 12
  if (years === 1 && rest < 3) return 'a year'
  if (rest >= 5 && rest <= 7) return years === 1 ? 'a year and a half' : `${numberWord(years)} and a half years`
  const rounded = rest > 7 ? years + 1 : years
  return rounded === 1 ? 'a year' : `${numberWord(rounded)} years`
}

/** Pure helpers available in every expression. */
const PURE_FNS = {
  min: (a: number, b: number) => Math.min(a, b),
  max: (a: number, b: number) => Math.max(a, b),
  abs: (a: number) => Math.abs(a),
  clamp: (x: number, lo: number, hi: number) => clamp(x, lo, hi),
  round: (a: number) => Math.round(a),
  floor: (a: number) => Math.floor(a),
  num: (n: number) => numberWord(n),
  ordinal: (n: number) => ordinalWord(n),
  span: (months: number) => spanWords(months),
  cap: (s: string) => (s.length ? s[0]!.toUpperCase() + s.slice(1) : s),
  /** Whole dollars with separators: "$12,300". The currency symbol follows the country pack later. */
  money: (n: number) => '$' + Math.round(n).toLocaleString('en-US'),
}

/** Helpers that need the person they are evaluated for. */
const CONTEXT_FN_NAMES = ['has', 'fired', 'monthsSince'] as const

export const FUNCTION_NAMES: string[] = [...Object.keys(PURE_FNS), ...CONTEXT_FN_NAMES]

const PRONOUNS = {
  male: { he: 'he', him: 'him', his: 'his', He: 'He', His: 'His', himself: 'himself' },
  female: { he: 'she', him: 'her', his: 'her', He: 'She', His: 'Her', himself: 'herself' },
}

/** Another person as content may read them, from the point of view of `self`. */
export function personView(state: GameState, self: Person, other: Person): Record<string, unknown> {
  const at = other.died?.at ?? state.now
  const work = other.work
  return {
    first: other.name.first,
    family: other.name.family,
    name: `${other.name.first} ${other.name.family}`,
    age: ageInYears(other.born, at),
    alive: !other.died,
    atHome: !other.died && other.householdId !== null && other.householdId === self.householdId,
    // "working", "out_of_work", or "at_home" for someone who is not in the labor market.
    work: !work || work.hours === 'none' ? 'at_home' : work.employed ? 'working' : 'out_of_work',
    partTime: work?.hours === 'part',
    word: relationOf(self, other),
    older: other.born < self.born,
    sex: other.sex,
    ...PRONOUNS[other.sex],
  }
}

function homeView(state: GameState, content: Prepared, self: Person): Record<string, unknown> {
  const home = self.householdId ? state.households[self.householdId] : undefined
  const parents = parentsAtHome(state, self)
  const poverty = content.bundle.country.family.poverty
  const ratio = home ? home.income / (poverty.base + poverty.perAdditional * Math.max(0, home.members.length - 1)) : 0
  const attention = involvement({ state, content }, self)
  const mother = self.motherId ? state.people[self.motherId] : undefined
  const father = self.fatherId ? state.people[self.fatherId] : undefined
  return {
    parents: parents.length,
    // The grown-ups at home as a child would say it: "your parents", "your mother", "your father".
    adults: parents.length >= 2 ? 'your parents' : parents.length === 1 ? `your ${parents[0]!.sex === 'female' ? 'mother' : 'father'}` : 'the adults at home',
    people: home?.members.length ?? 1,
    children: home ? home.members.filter((id) => ageInYears(state.people[id]?.born ?? 0, state.now) < 18).length : 0,
    place: content.bundle.country.states.find((s) => s.id === home?.state)?.name ?? content.bundle.country.name,
    // Income against needs in words a child could feel: "poor", "tight", "steady", "comfortable", "well_off".
    money: ratio < 1 ? 'poor' : ratio < 2 ? 'tight' : ratio < 4 ? 'steady' : ratio < 7 ? 'comfortable' : 'well_off',
    disruption: home?.disruption ?? 0,
    // How much time and attention the parents have for the child: "little", "some" or "plenty".
    attention: attention < -0.6 ? 'little' : attention > 0.5 ? 'plenty' : 'some',
    // How the parents stand to each other: "married", "cohabiting", or "apart".
    couple: mother && father && mother.partner?.id === father.id ? mother.partner.status : 'apart',
    school: self.education.school?.name ?? '',
    teacher: self.education.school?.teacher ?? '',
  }
}

export interface EnvExtras {
  process?: ProcessInstance
  fact?: Record<string, Scalar>
}

export function fitnessRatio(content: Prepared, p: Person, month: number): number {
  const env = content.envelope('cardio', (month - p.born) / 12)
  return env > 0 ? p.body.cardio / env : 0
}

export function makeEnv(state: GameState, content: Prepared, p: Person, extras: EnvExtras = {}): Env {
  const month = state.now
  const age = ageInYears(p.born, month)
  const self = {
    age,
    ageMonths: month - p.born,
    sex: p.sex,
    stage: content.stageFor(age),
    cardio: p.body.cardio,
    strength: p.body.strength,
    fitness: fitnessRatio(content, p, month),
    activity: p.policies.activity,
    activityLevel: content.activityIndex.get(p.policies.activity) ?? 0,
    isPlayer: p.id === state.playerId,
    first: p.name.first,
    family: p.name.family,
    name: `${p.name.first} ${p.name.family}`,
    flag: p.flags,
    trait: p.traits,
    schooling: p.education.status,
    grade: p.education.grade ?? -1,
    study: p.policies.study,
    olderSiblings: siblingsOf(state, p).filter((s) => s.born < p.born).length,
    siblings: siblingsOf(state, p).length,
  }
  const world = {
    month: monthOf(month) + 1,
    monthName: MONTH_NAMES[monthOf(month)]!,
    year: yearOf(month),
    season: seasonOf(month),
  }
  const mother = p.motherId ? state.people[p.motherId] : undefined
  const father = p.fatherId ? state.people[p.fatherId] : undefined
  const vars: Record<string, unknown> = {
    self,
    world,
    home: homeView(state, content, p),
    mother: mother ? personView(state, p, mother) : null,
    father: father ? personView(state, p, father) : null,
  }
  if (extras.process) {
    vars.process = {
      stage: extras.process.stage,
      monthsInStage: month - extras.process.stageEntered,
      months: month - extras.process.started,
    }
  }
  if (extras.fact) {
    vars.fact = extras.fact
    // A fact about someone else names them by id; content reads them as `who` (and `stays`).
    for (const key of ['who', 'stays'] as const) {
      const id = extras.fact[key]
      const other = typeof id === 'string' ? state.people[id] : undefined
      vars[key] = other ? personView(state, p, other) : null
    }
  }

  const fns = {
    ...PURE_FNS,
    has: (def: string) => {
      for (const id in state.processes) {
        const inst = state.processes[id]!
        if (inst.subjectId === p.id && inst.def === def) return true
      }
      return false
    },
    fired: (eventId: string) => p.eventHistory[eventId]?.count ?? 0,
    monthsSince: (eventId: string) => {
      const h = p.eventHistory[eventId]
      return h ? month - h.last : 9999
    },
  }
  return { vars, fns: fns as unknown as Env['fns'] }
}
