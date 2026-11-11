/**
 * US taxes and benefits (design §7.14, §12.4): the rules that are formulas rather than tables.
 * Federal income tax with the child and earned-income credits, payroll tax, a state's income tax,
 * the Social Security retirement benefit, SNAP, and what health cover costs. All numbers come
 * from the country pack. Every function here is pure and works in start-year dollars; callers
 * convert with the price level, because the rules are indexed to prices (design decision Q7).
 */

import type { MoneyDef, TaxDef } from '../../content/country-schema'
import { clamp, interpolate } from '../../core/dmath'

export type FilingStatus = 'single' | 'joint' | 'head'

/** Tax on taxable income from the bracket schedule. */
export function bracketTax(tax: TaxDef, status: FilingStatus, taxable: number): number {
  let owed = 0
  let floor = 0
  const rows = tax.brackets[status]
  for (let i = 0; i < rows.length; i++) {
    const [rate, upTo] = rows[i]!
    const top = i === rows.length - 1 ? Infinity : upTo
    if (taxable <= floor) break
    owed += rate * (Math.min(taxable, top) - floor)
    floor = top
  }
  return owed
}

export interface Return {
  status: FilingStatus
  /** Earnings from work, and other taxable income, for the year. */
  wages: number
  other: number
  /** Children under seventeen in the household. */
  children: number
  /** Age of the filer, for the childless earned-income credit. */
  age: number
}

export interface Liability {
  /** Income tax before credits. */
  tax: number
  childCredit: number
  earnedIncomeCredit: number
  /** What is owed for the year after credits; negative when the credits exceed the tax. */
  net: number
}

/** The earned-income credit: it builds with earnings, levels off, then shrinks. */
export function earnedIncomeCredit(tax: TaxDef, r: Return): number {
  const E = tax.earnedIncomeCredit
  const row = E.byChildren[Math.min(3, r.children)]!
  if (r.children === 0 && (r.age < E.childlessAges[0] || r.age > E.childlessAges[1])) return 0
  const start = r.status === 'joint' ? row.phaseOutStartJoint : row.phaseOutStart
  const income = Math.max(r.wages, r.wages + r.other)
  return Math.max(0, Math.min(row.max, row.phaseIn * r.wages) - row.phaseOut * Math.max(0, income - start))
}

export function federalIncomeTax(tax: TaxDef, r: Return): Liability {
  const income = r.wages + r.other
  const before = bracketTax(tax, r.status, Math.max(0, income - tax.standardDeduction[r.status]))
  const C = tax.childCredit
  const credit = Math.max(0, C.perChild * r.children - 0.05 * Math.max(0, income - C.phaseOut[r.status]))
  // The credit first wipes out tax; of what is left over, a limited part is paid out.
  const used = Math.min(before, credit)
  const refundable = Math.min(credit - used, C.refundable * r.children, C.refundRate * Math.max(0, r.wages - C.earnedAbove))
  const eitc = earnedIncomeCredit(tax, r)
  return { tax: before, childCredit: used + refundable, earnedIncomeCredit: eitc, net: before - used - refundable - eitc }
}

/** The employee's payroll tax on one more amount of wages, given wages so far this year. */
export function payrollTax(tax: TaxDef, wagesSoFar: number, wages: number): number {
  const P = tax.payroll
  const covered = clamp(P.wageBase - wagesSoFar, 0, wages)
  return P.socialSecurity * covered + P.medicare * wages
}

/** State income tax for the year: one effective rate on income above the federal standard deduction. */
export function stateIncomeTax(tax: TaxDef, ratePercent: number, status: FilingStatus, income: number): number {
  return (ratePercent / 100) * Math.max(0, income - tax.standardDeduction[status])
}

/**
 * The monthly retirement benefit at full retirement age (the primary insurance amount), from a
 * record of yearly earnings: the best 35 years, averaged by month, through the bend-point formula.
 */
export function primaryInsuranceAmount(tax: TaxDef, earnings: readonly number[]): number {
  const S = tax.socialSecurity
  const best = [...earnings].map((e) => Math.min(e, tax.payroll.wageBase)).sort((a, b) => b - a).slice(0, S.years)
  const aime = best.reduce((a, b) => a + b, 0) / (S.years * 12)
  const [first, second] = S.bendPoints
  return S.rates[0] * Math.min(aime, first) + S.rates[1] * clamp(aime - first, 0, second - first) + S.rates[2] * Math.max(0, aime - second)
}

/** The benefit as a share of the full amount when claimed at a given age in months. */
export function claimingFactor(tax: TaxDef, ageMonths: number): number {
  const S = tax.socialSecurity
  const early = Math.round(S.fullAge * 12 - clamp(ageMonths, S.earliestAge * 12, S.latestAge * 12))
  if (early <= 0) return 1 + S.delayedPerMonth * -early
  return 1 - S.earlyPerMonth[0] * Math.min(36, early) - S.earlyPerMonth[1] * Math.max(0, early - 36)
}

/** SNAP for a month, given the household's monthly income, how much of it is earned, and the monthly poverty line. */
export function snapBenefit(money: MoneyDef, monthlyIncome: number, earned: number, size: number, monthlyPoverty: number): number {
  const S = money.snap
  if (size < 1 || monthlyIncome > S.grossLimit * monthlyPoverty) return 0
  const max = size <= S.maxMonthly.length ? S.maxMonthly[size - 1]! : S.maxMonthly[S.maxMonthly.length - 1]! + S.perAdditional * (size - S.maxMonthly.length)
  const net = Math.max(0, monthlyIncome - S.deduction - S.earnedDeduction * earned)
  const benefit = max - S.benefitReduction * net
  // One- and two-person households that qualify receive at least a small minimum.
  return benefit > 0 ? Math.max(benefit, size <= 2 ? 23 : 0) : 0
}

export type Cover = 'employer' | 'public' | 'marketplace' | 'medicare' | 'none'

/**
 * What kind of health cover an adult has and what it costs a year (premium plus typical
 * out-of-pocket spending), given the income of the household as a multiple of the poverty line.
 */
export function healthCover(money: MoneyDef, who: { age: number; offered: boolean; family: boolean; expansionState: boolean; income: number; povertyRatio: number; willingness: number }): { cover: Cover; cost: number } {
  const H = money.health
  // Medicaid pays the Medicare premium and most costs for retirees on low incomes.
  if (who.age >= H.medicare.age) return { cover: 'medicare', cost: who.povertyRatio <= H.medicare.helpBelow ? H.outOfPocket.publicCover : H.medicare.premium + H.outOfPocket.medicare }
  if (who.offered) return { cover: 'employer', cost: (who.family ? H.employer.family : H.employer.single) + H.outOfPocket.insured }
  if (who.willingness < H.neverEnroll) return { cover: 'none', cost: H.outOfPocket.uninsured }
  if (who.expansionState && who.povertyRatio <= H.medicaid.adults) return { cover: 'public', cost: H.outOfPocket.publicCover }
  const premium = H.marketplace.benchmark * interpolate(H.marketplace.ageFactor, who.age)
  // Below the poverty line in a state that has not expanded Medicaid there is no subsidy at all.
  const subsidized = who.povertyRatio >= 1 || who.expansionState
  const toPay = subsidized ? Math.min(premium, interpolate(H.marketplace.contribution, who.povertyRatio) * who.income) : premium
  // How much people will pay before going without varies: the threshold is spread around its typical value.
  if (toPay <= 2 * who.willingness * H.marketplace.buysIfUnder * Math.max(who.income, 1)) return { cover: 'marketplace', cost: toPay + H.outOfPocket.insured }
  return { cover: 'none', cost: H.outOfPocket.uninsured }
}
