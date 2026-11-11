/**
 * Money (design §7.14). Every dollar is in an account, in whole cents, and every movement takes
 * from one account and gives to another, so money is conserved by construction: the balances of
 * all accounts sum to zero, always. A debt is an account with a negative balance. The rest of the
 * world (employers, government, lenders, markets, merchants, landlords) holds the other side.
 */

import { clamp, dpow } from '../core/dmath'
import type { Prepared } from '../content/prepare'
import type { GameState, Money, Person } from '../state'

export const KINDS = ['cash', 'invest', 'retire', 'home', 'card', 'student', 'private', 'mortgage'] as const
export type Kind = (typeof KINDS)[number]
export const ASSETS: Kind[] = ['cash', 'invest', 'retire', 'home']
export const DEBTS: Kind[] = ['card', 'student', 'private', 'mortgage']

export const WORLD = {
  employers: 'world:employers',
  government: 'world:government',
  lenders: 'world:lenders',
  markets: 'world:markets',
  merchants: 'world:merchants',
  landlords: 'world:landlords',
  housing: 'world:housing',
  colleges: 'world:colleges',
} as const

export function acct(owner: string, kind: Kind): string {
  return `${owner}:${kind}`
}

/** Balance in cents. */
export function balance(state: GameState, owner: string, kind: Kind): number {
  return state.accounts[`${owner}:${kind}`] ?? 0
}

/** Balance in dollars. */
export function dollars(state: GameState, owner: string, kind: Kind): number {
  return (state.accounts[`${owner}:${kind}`] ?? 0) / 100
}

/** Moves a dollar amount from one account to another. Amounts are rounded to the cent; nothing moves for zero or less. */
export function move(state: GameState, from: string, to: string, amount: number): number {
  const cents = Math.round(amount * 100)
  if (!(cents > 0) || from === to) return 0
  state.accounts[from] = (state.accounts[from] ?? 0) - cents
  state.accounts[to] = (state.accounts[to] ?? 0) + cents
  return cents / 100
}

/** Everything a person owns less everything they owe, in dollars. */
export function netWorth(state: GameState, owner: string): number {
  let total = 0
  for (const kind of KINDS) total += state.accounts[`${owner}:${kind}`] ?? 0
  return total / 100
}

export function blankMoney(): Money {
  return { credit: { history: 0.6, marks: [], opened: null, evicted: null }, tax: { wages: 0, other: 0, withheld: 0 }, taxDue: null, missed: 0, hardship: 0, cover: 'none', student: null }
}

/** Monthly payment that clears a loan in `months` at a yearly rate in percent. */
export function loanPayment(principal: number, ratePercent: number, months: number): number {
  const r = ratePercent / 1200
  if (principal <= 0) return 0
  if (r <= 0) return principal / months
  return (principal * r) / (1 - dpow(1 + r, -months))
}

/** The limit on a person's credit card, in dollars, given their yearly income. */
export function cardLimit(content: Prepared, score: number, yearlyIncome: number, priceLevel: number): number {
  const c = content.bundle.country.money.credit
  const t = clamp((score - c.floor) / c.range, 0, 1)
  return Math.max(500 * priceLevel, yearlyIncome * (c.limitShare[0] + (c.limitShare[1] - c.limitShare[0]) * t))
}

/**
 * The credit score (design §7.14): latent, built from what the real ones count. Payment history,
 * how much of the available credit is in use, how long the file has existed, and serious marks,
 * which fade over seven years.
 */
export function creditScore(state: GameState, content: Prepared, person: Person, yearlyIncome = 0): number {
  const c = content.bundle.country.money.credit
  const m = person.money
  if (!m) return c.floor + c.range * 0.6
  const age = m.credit.opened === null ? 0 : clamp((state.now - m.credit.opened) / 12 / c.fullAgeYears, 0, 1)
  let marks = 0
  for (const at of m.credit.marks) marks += Math.max(0, 1 - (state.now - at) / (12 * c.markYears))
  const owed = -balance(state, person.id, 'card') / 100
  // Utilization is judged against a limit that itself depends on the score; a mid-range limit avoids the circle.
  const limit = Math.max(500 * state.world.priceLevel, yearlyIncome * (c.limitShare[0] + c.limitShare[1]) * 0.5)
  const utilization = clamp(owed / limit, 0, 1)
  const quality = c.weights.history * m.credit.history + c.weights.utilization * (1 - utilization) + c.weights.age * (0.1 + 0.9 * age) + c.weights.marks * Math.max(0, 1 - marks)
  return Math.round(c.floor + c.range * clamp(quality, 0, 1))
}

/** Marks a serious failure to pay on the credit file. */
export function creditMark(state: GameState, person: Person): void {
  const m = person.money
  if (!m) return
  m.credit.marks = m.credit.marks.filter((at) => state.now - at < 12 * 10)
  m.credit.marks.push(state.now)
  m.credit.history *= 0.6
}
