/**
 * Country rules (design §12.4). Most of a country is data, but some of it is logic that no table
 * can hold: how a family forms, how a school system moves a pupil along. Each country supplies
 * that logic behind this interface, reading all of its numbers from its own data files. The core
 * engine knows only that these things exist.
 */

import type { Ctx } from '../context'
import type { Person, StartOptions } from '../state'
import { educationMonth } from './us/education'
import { createFamily, familyAfterDeath, familyMonth } from './us/family'
import { moneyMonth } from './us/household'
import { workMonth } from './us/work'

export interface CountryRules {
  /** Builds the family a new character is born into and returns the character, placed in it. */
  createFamily(ctx: Ctx, start: StartOptions, self: { sex: 'male' | 'female'; birthDay: number }): Person
  /** One month of family life for everyone: work, partnerships, births, household money. */
  familyMonth(ctx: Ctx): void
  /** One month of schooling for one person. */
  educationMonth(ctx: Ctx, person: Person): void
  /** One month of the labor market for everyone: employers, jobs, searches, retirement. */
  workMonth(ctx: Ctx): void
  /** One month of money for everyone: pay, tax, bills, spending, saving, housing. */
  moneyMonth(ctx: Ctx): void
  /** Called when someone dies, so those left behind can rearrange themselves. */
  afterDeath(ctx: Ctx, dead: Person): void
}

const RULES: Record<string, CountryRules> = {
  us: { createFamily, familyMonth, educationMonth, workMonth, moneyMonth, afterDeath: familyAfterDeath },
}

export function rulesFor(countryId: string): CountryRules {
  const rules = RULES[countryId]
  if (!rules) throw new Error(`No rules module for country '${countryId}'`)
  return rules
}
