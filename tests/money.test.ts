import { describe, expect, it } from 'vitest'
import { checkInvariants, step, type GameState } from '../src/engine'
import { claimingFactor, earnedIncomeCredit, federalIncomeTax, healthCover, payrollTax, primaryInsuranceAmount, snapBenefit } from '../src/engine/country/us/tax'
import { loanPayment, netWorth } from '../src/engine/systems/money'
import { playYear } from '../src/tools/players'
import { newLife, realContent, testEnv } from './helpers'

const content = realContent()
const tax = content.bundle.country.tax
const money = content.bundle.country.money

describe('federal income tax (IRS Rev. Proc. 2024-40, tax year 2025)', () => {
  it('works out the tax on a single filer from the brackets', () => {
    // $50,000 of wages, less the $15,000 standard deduction: 10% of 11,925 and 12% of the rest.
    const r = federalIncomeTax(tax, { status: 'single', wages: 50000, other: 0, children: 0, age: 40 })
    expect(r.tax).toBeCloseTo(0.1 * 11925 + 0.12 * (35000 - 11925), 2)
    expect(r.net).toBeCloseTo(r.tax, 2)
  })

  it('a married couple filing jointly pays on income above $30,000', () => {
    const r = federalIncomeTax(tax, { status: 'joint', wages: 100000, other: 0, children: 0, age: 40 })
    expect(r.tax).toBeCloseTo(0.1 * 23850 + 0.12 * (70000 - 23850), 2)
  })

  it('the child tax credit wipes out the tax and pays out part of the rest', () => {
    // Head of household, $30,000, two children: $750 of tax, a $4,000 credit; $3,250 is paid out
    // (below the $1,700-a-child limit and 15% of earnings over $2,500).
    const r = federalIncomeTax(tax, { status: 'head', wages: 30000, other: 0, children: 2, age: 35 })
    expect(r.tax).toBeCloseTo(750, 2)
    expect(r.childCredit).toBeCloseTo(4000, 2)
  })

  it('the earned income credit builds, levels off and shrinks', () => {
    const credit = (wages: number, children: number): number => earnedIncomeCredit(tax, { status: 'single', wages, other: 0, children, age: 30 })
    expect(credit(5000, 1)).toBeCloseTo(0.34 * 5000, 2)
    expect(credit(15000, 1)).toBeCloseTo(4328, 2)
    expect(credit(40000, 1)).toBeCloseTo(4328 - 0.1598 * (40000 - 23350), 2)
    expect(credit(80000, 1)).toBe(0)
    // Childless workers qualify only between 25 and 64.
    expect(earnedIncomeCredit(tax, { status: 'single', wages: 8000, other: 0, children: 0, age: 22 })).toBe(0)
  })

  it('payroll tax stops for Social Security at the wage base and goes on for Medicare', () => {
    expect(payrollTax(tax, 0, 10000)).toBeCloseTo(765, 2)
    expect(payrollTax(tax, 176100, 10000)).toBeCloseTo(145, 2)
  })
})

describe('Social Security (SSA, 2025 formula)', () => {
  it('computes the benefit from the best 35 years of earnings through the bend points', () => {
    // $60,000 for 35 years is an average monthly wage of $5,000.
    const pia = primaryInsuranceAmount(tax, new Array(35).fill(60000))
    expect(pia).toBeCloseTo(0.9 * 1226 + 0.32 * (5000 - 1226), 2)
    // Extra low years do not count; fewer than 35 years count as zeros.
    expect(primaryInsuranceAmount(tax, [...new Array(35).fill(60000), 1000, 2000])).toBeCloseTo(pia, 6)
    expect(primaryInsuranceAmount(tax, new Array(20).fill(60000))).toBeLessThan(pia)
  })

  it('claiming at 62 pays 70% of the full amount, and waiting to 70 pays 124%', () => {
    expect(claimingFactor(tax, 62 * 12)).toBeCloseTo(0.7, 3)
    expect(claimingFactor(tax, 67 * 12)).toBe(1)
    expect(claimingFactor(tax, 70 * 12)).toBeCloseTo(1.24, 3)
  })
})

describe('benefits and health cover', () => {
  it('SNAP pays the maximum to a household with no income, and nothing above the limit', () => {
    const line = 15650 / 12
    expect(snapBenefit(money, 0, 0, 1, line)).toBe(money.snap.maxMonthly[0])
    expect(snapBenefit(money, 2 * line, 2 * line, 1, line)).toBe(0)
  })

  it('cover follows age, the job, the state and income', () => {
    const base = { age: 40, offered: false, family: false, expansionState: true, income: 15000, povertyRatio: 0.95, willingness: 0.5 }
    expect(healthCover(money, { ...base, age: 70 }).cover).toBe('medicare')
    expect(healthCover(money, { ...base, offered: true }).cover).toBe('employer')
    expect(healthCover(money, base).cover).toBe('public')
    // The coverage gap: below the poverty line in a state that did not expand Medicaid, no subsidy.
    expect(healthCover(money, { ...base, expansionState: false, willingness: 0.2 }).cover).toBe('none')
    expect(healthCover(money, { ...base, willingness: 0.01 }).cover).toBe('none')
  })

  it('amortizes a loan the way a lender does', () => {
    expect(loanPayment(200000, 6, 360)).toBeCloseTo(1199.1, 1)
    expect(loanPayment(12000, 0, 12)).toBeCloseTo(1000, 6)
  })
})

describe('money in a lived life', () => {
  const env = testEnv(content, false)
  const lives: GameState[] = []
  for (let i = 0; i < 12; i++) {
    let s = newLife(`money-${i}`, env)
    while (s.phase === 'alive' && s.now - s.people.p1!.born < 12 * 70) s = playYear(s, 'persona', env)
    lives.push(s)
  }

  it('money is conserved: every account sums to zero and every invariant holds', () => {
    for (const s of lives) {
      expect(Object.values(s.accounts).reduce((a, b) => a + b, 0)).toBe(0)
      expect(checkInvariants(s, content)).toEqual([])
    }
  })

  it('prices rise over a life and pay follows them', () => {
    for (const s of lives) {
      const w = s.world
      const years = (s.now - s.people.p1!.born) / 12
      if (years < 40) continue
      const inflation = Math.log(w.priceLevel) / years
      expect(inflation).toBeGreaterThan(0.01)
      expect(inflation).toBeLessThan(0.05)
      expect(Math.abs(Math.log(w.wageIndex / w.priceLevel))).toBeLessThan(0.25)
    }
  })

  it('most people have worked, paid tax and built something by sixty', () => {
    const grown = lives.filter((s) => s.now - s.people.p1!.born >= 12 * 60)
    expect(grown.length).toBeGreaterThan(6)
    const worked = grown.filter((s) => (s.people.p1!.work?.history.length ?? 0) > 0 || s.people.p1!.work?.job)
    expect(worked.length / grown.length).toBeGreaterThan(0.8)
    const positive = grown.filter((s) => netWorth(s, 'p1') > 0)
    expect(positive.length / grown.length).toBeGreaterThan(0.5)
  })

  it('a policy change takes effect and is reported', () => {
    let s = lives.find((x) => x.phase === 'alive')!
    s = step(s, { type: 'setPolicy', policy: { saving: 'heavy', lifestyle: 'frugal' } }, env).state
    expect(s.people.p1!.policies.saving).toBe('heavy')
    expect(s.log.at(-1)!.fact.kind).toBe('policy_changed')
  })
})
