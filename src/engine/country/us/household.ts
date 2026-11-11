/**
 * Household money and housing (design §7.14, §7.2). Each month, for everyone: pay arrives with
 * tax withheld; accounts earn or cost interest; then each household pays its bills in order of
 * need, spends at its chosen level, and saves or falls short. A shortfall draws on savings, then
 * on credit, then on missed payments, each with consequences. Taxes are settled each April.
 *
 * A couple who live together run one set of books, kept by one of them (the "head"). Adults who
 * live in a home someone else pays for keep their own money and pay little.
 */

import { approach, clamp, dexp, dlog, dpow, interpolate, logistic } from '../../core/dmath'
import { KeyedRng } from '../../core/rng'
import { monthOf } from '../../core/time'
import { emitFact, type Ctx, type SourceClass } from '../../context'
import type { Prepared } from '../../content/prepare'
import { ageYears, childrenOf, householdOf, joinHousehold, parentsOf } from '../../people'
import { livingPeople, newId, type GameState, type Household, type OutcomeRecord, type Person, type Scalar } from '../../state'
import { registerAction } from '../../systems/actions'
import { hasOpenDecision, openDecision, plainText, registerSystemDecision } from '../../systems/decisions'
import { ASSETS, DEBTS, KINDS, WORLD, acct, balance, cardLimit, creditMark, creditScore, dollars, loanPayment, move, netWorth } from '../../systems/money'
import { bracketTax, federalIncomeTax, healthCover, payrollTax, snapBenefit, stateIncomeTax, type FilingStatus } from './tax'
import { currentIncome, ensureMoney } from './work'

const ADULT = 18

type Reader = Pick<Ctx, 'state' | 'content'>

function reader(state: GameState, content: Prepared): Ctx {
  return { state, content, rng: new KeyedRng(state.meta.seed), narrator: null, facts: [], interrupted: false }
}

function tell(ctx: Ctx, person: Person, kind: string, data: Record<string, Scalar>, options: { significant?: boolean; source?: SourceClass; outcomeId?: string } = {}): void {
  emitFact(ctx, { kind, subject: person, data, significant: options.significant ?? false, ...(options.outcomeId ? { outcomeId: options.outcomeId } : {}) }, { sourceClass: options.source ?? 'structural' })
}

/** The poverty line for a household of a given size, in start-year dollars a year. */
export function povertyLine(ctx: Reader, size: number): number {
  const p = ctx.content.bundle.country.family.poverty
  return p.base + p.perAdditional * Math.max(0, size - 1)
}

function placeOf(content: Prepared, home: Household | null) {
  const states = content.bundle.country.states
  return states.find((s) => s.id === home?.state) ?? states[0]!
}

/** Who keeps the books: of a couple living together, the one with the smaller id; otherwise the person. */
export function unitHead(state: GameState, person: Person): Person {
  const other = person.partner ? state.people[person.partner.id] : undefined
  if (!other || other.died || other.householdId !== person.householdId) return person
  return other.id < person.id ? other : person
}

function unitAdults(state: GameState, head: Person): Person[] {
  const other = head.partner ? state.people[head.partner.id] : undefined
  return other && !other.died && other.householdId === head.householdId ? [head, other] : [head]
}

/** Whether this person's unit pays for the home they live in. */
function paysForHome(state: GameState, head: Person, home: Household): boolean {
  const payer = home.housing.payer
  return payer !== null && unitAdults(state, head).some((a) => a.id === payer)
}

/** Monthly rent for a home in the dollars of the day. */
export function marketRent(ctx: Reader, stateId: string, tier: number, size: number, shared: boolean): number {
  const H = ctx.content.bundle.country.money.housing
  const place = ctx.content.bundle.country.states.find((s) => s.id === stateId) ?? ctx.content.bundle.country.states[0]!
  const rent = place.rent * H.rentByTier[clamp(tier, 1, 5) - 1]! * (1 + H.perExtraPerson * Math.max(0, size - 2)) * (shared ? H.sharedRent : 1) * ctx.state.world.priceLevel
  return Math.round(rent / 5) * 5
}

/** Price of a home in the dollars of the day. */
export function homePrice(ctx: Reader, stateId: string, tier: number): number {
  const H = ctx.content.bundle.country.money.housing
  const place = ctx.content.bundle.country.states.find((s) => s.id === stateId) ?? ctx.content.bundle.country.states[0]!
  return Math.round((place.home * H.priceByTier[clamp(tier, 1, 5) - 1]! * ctx.state.world.housingIndex) / 1000) * 1000
}

/** A person's yearly income for a lender or a landlord: what they and a partner at home bring in. */
function unitIncome(ctx: Reader, head: Person): number {
  return unitAdults(ctx.state, head).reduce((a, p) => a + currentIncome(ctx, p), 0)
}

export function scoreOf(ctx: Reader, person: Person): number {
  return creditScore(ctx.state, ctx.content, person, unitIncome(ctx, unitHead(ctx.state, person)))
}

// ---------------------------------------------------------------------------------------------
// Pay, taxes, returns
// ---------------------------------------------------------------------------------------------

interface Flow {
  /** This month, in dollars of the day: income before tax, the part of it earned, and what arrived after tax. */
  gross: number
  earned: number
  net: number
}

function payMonth(ctx: Ctx, person: Person, flows: Map<string, Flow>): void {
  const { state, content } = ctx
  const work = person.work
  if (!work) return
  const money = ensureMoney(person)
  const tax = content.bundle.country.tax
  const px = state.world.priceLevel
  const head = unitHead(state, person)
  const cash = acct(head.id, 'cash')
  const flow: Flow = { gross: 0, earned: 0, net: 0 }
  const job = work.job
  if (job) {
    const gross = job.salary / 12
    const saving = content.bundle.country.money.saving
    const level = saving.levels.find((l) => l.id === person.policies.saving) ?? saving.levels[0]!
    // Retirement contributions come out before tax; without a plan at work, only determined savers make them.
    const contribution = ageYears(person, state.now) >= ADULT && (job.match > 0 || level.invests) ? gross * level.retirement : 0
    const match = Math.min(contribution, gross * job.match)
    const yearly = ((gross - contribution) * 12) / px
    const place = placeOf(content, householdOf(state, person))
    const withheld = ((bracketTax(tax, 'single', Math.max(0, yearly - tax.standardDeduction.single)) + stateIncomeTax(tax, place.incomeTax, 'single', yearly)) * px) / 12
    const payroll = payrollTax(tax, money.tax.wages / px, gross / px) * px
    const net = gross - contribution - withheld - payroll
    move(state, WORLD.employers, cash, net)
    move(state, WORLD.employers, WORLD.government, withheld + payroll)
    move(state, WORLD.employers, acct(person.id, 'retire'), contribution + match)
    money.tax.wages += gross - contribution
    money.tax.withheld += withheld
    work.yearWages += gross
    flow.gross += gross
    flow.earned += gross
    flow.net += net
  } else if (work.insurance) {
    if (state.now <= work.insurance.until) {
      const amount = (work.insurance.weekly * 52) / 12
      move(state, WORLD.government, cash, amount)
      money.tax.other += amount
      flow.gross += amount
      flow.net += amount
    } else {
      work.insurance = null
      tell(ctx, person, 'benefits_ended', { months: work.since === null ? 0 : state.now - work.since }, { significant: true })
    }
  }
  if (work.benefit) {
    const amount = work.benefit.monthly * px
    move(state, WORLD.government, cash, amount)
    money.tax.other += amount
    flow.gross += amount
    flow.net += amount
  }
  if (work.pension > 0 && work.status === 'retired' && ageYears(person, state.now) >= content.bundle.country.money.pension.fromAge) {
    const amount = work.pension * px
    move(state, WORLD.employers, cash, amount)
    money.tax.other += amount
    flow.gross += amount
    flow.net += amount
  }
  flows.set(person.id, flow)
}

/** Children in the home whom this unit can claim, under a given age. */
function dependents(state: GameState, head: Person, underAge: number): Person[] {
  const home = householdOf(state, head)
  if (!home) return []
  const adults = unitAdults(state, head).map((a) => a.id)
  return home.members
    .map((id) => state.people[id])
    .filter((c): c is Person => !!c && ageYears(c, state.now) < underAge && ((c.motherId !== null && adults.includes(c.motherId)) || (c.fatherId !== null && adults.includes(c.fatherId))))
}

/** April: last year's tax is worked out properly, and the difference from what was withheld is refunded or billed. */
function settleTaxes(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  const money = person.money
  if (!money || !money.taxDue) return
  const tax = content.bundle.country.tax
  const px = state.world.priceLevel
  const head = unitHead(state, person)
  const adults = unitAdults(state, head)
  const married = adults.length === 2 && head.partner?.status === 'married'
  if (married && head.id !== person.id) return
  const due = { ...money.taxDue }
  money.taxDue = null
  if (married) {
    const other = adults.find((a) => a.id !== person.id)?.money
    if (other?.taxDue) {
      due.wages += other.taxDue.wages
      due.other += other.taxDue.other
      due.withheld += other.taxDue.withheld
      other.taxDue = null
    }
  }
  if (due.wages <= 0 && due.other <= 0 && due.withheld <= 0) return
  const children = head.id === person.id ? dependents(state, head, tax.childCredit.underAge).length : 0
  const status: FilingStatus = married ? 'joint' : children > 0 ? 'head' : 'single'
  const wages = due.wages / px
  const other = (due.other * tax.benefitsTaxableShare) / px
  const federal = federalIncomeTax(tax, { status, wages, other, children, age: ageYears(person, state.now) })
  const stateTax = stateIncomeTax(tax, placeOf(content, householdOf(state, person)).incomeTax, status, wages + other)
  const owed = Math.round((federal.net + stateTax) * px - due.withheld)
  if (owed < 0) move(state, WORLD.government, acct(head.id, 'cash'), -owed)
  else payFrom(ctx, head, owed, WORLD.government, true)
  // Told when it is news: a different outcome from last year's, or a sum that matters.
  const which = owed < -50 * px ? 'refund' : owed > 50 * px ? 'bill' : 'even'
  if (person.flags['money.lastTax'] !== which || Math.abs(owed) > 0.04 * (due.wages + due.other)) {
    tell(ctx, person, 'tax_settled', { which, amount: Math.abs(owed), credits: Math.round((federal.childCredit + federal.earnedIncomeCredit) * px) })
  }
  person.flags['money.lastTax'] = which
}

function returnsMonth(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  const w = state.world
  const rates = content.bundle.country.economy.rates
  const id = person.id
  const money = person.money
  if (!money) return
  const cash = dollars(state, id, 'cash')
  if (cash > 0) move(state, WORLD.markets, acct(id, 'cash'), (cash * w.policyRate * rates.savingsShare) / 1200)
  const gain = (kind: 'invest' | 'retire' | 'home', rate: number, other: string): void => {
    const held = dollars(state, id, kind)
    if (held <= 0) return
    if (rate >= 0) move(state, other, acct(id, kind), held * rate)
    else move(state, acct(id, kind), other, held * -rate)
  }
  gain('invest', w.stockReturn, WORLD.markets)
  const inStocks = interpolate(content.bundle.country.money.saving.stockShare, ageYears(person, state.now))
  gain('retire', inStocks * w.stockReturn + (1 - inStocks) * w.bondReturn, WORLD.markets)
  gain('home', w.housingReturn, WORLD.housing)

  const owe = (kind: 'card' | 'student' | 'private' | 'mortgage', ratePercent: number): void => {
    const owed = -dollars(state, id, kind)
    if (owed > 0) move(state, acct(id, kind), WORLD.lenders, (owed * ratePercent) / 1200)
  }
  const credit = content.bundle.country.money.credit
  owe('card', w.policyRate + rates.cardSpread + (Math.max(0, 760 - creditScore(state, content, person)) / 100) * credit.aprPer100)
  // Federal loans cost nothing while the borrower is studying or in the months of grace after.
  if (money.student) owe('student', rates.studentLoan)
  owe('private', rates.studentLoan + content.bundle.country.money.studentLoans.privateSpread)
  const home = householdOf(state, person)
  if (home?.housing.mortgage && home.housing.payer === id) owe('mortgage', home.housing.mortgage.rate)
}

// ---------------------------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------------------------

/**
 * Pays an amount out of a unit's cash, raising the cash first if it has to: investments are sold,
 * retirement savings are drawn once old enough, and what is still missing goes on the card if
 * `mayBorrow`. Returns what was actually paid.
 */
function payFrom(ctx: Ctx, head: Person, amount: number, to: string, mayBorrow: boolean, lastResort = false): number {
  const { state, content } = ctx
  // A payment toward a debt never pays more than is owed on it.
  const [owner, kind] = to.split(':')
  if (owner !== 'world' && (DEBTS as readonly string[]).includes(kind ?? '')) amount = Math.min(amount, -(state.accounts[to] ?? 0) / 100)
  if (amount <= 0) return 0
  const cash = acct(head.id, 'cash')
  const adults = unitAdults(state, head)
  let short = amount - dollars(state, head.id, 'cash')
  const draw = (kind: 'invest' | 'retire'): void => {
    for (const adult of adults) {
      if (short <= 0) return
      if (kind === 'retire' && !lastResort && ageYears(adult, state.now) < 60) continue
      const taken = move(state, acct(adult.id, kind), cash, Math.min(short, dollars(state, adult.id, kind)))
      if (kind === 'retire' && adult.money) adult.money.tax.other += taken
      short -= taken
    }
  }
  if (short > 0) draw('invest')
  if (short > 0) draw('retire')
  // A card that was written off is closed; for a while after a serious mark, no lender offers another.
  const lastMark = head.money?.credit.marks.at(-1)
  const shutOut = lastMark !== undefined && state.now - lastMark < content.bundle.country.money.credit.closedAfterMarkMonths
  if (short > 0 && mayBorrow && !shutOut && head.money?.credit.opened !== null) {
    const limit = cardLimit(content, creditScore(state, content, head, unitIncome(ctx, head)), unitIncome(ctx, head), state.world.priceLevel)
    const room = limit + dollars(state, head.id, 'card')
    short -= move(state, acct(head.id, 'card'), cash, Math.min(short, room))
  }
  return move(state, cash, to, Math.min(amount, Math.max(0, dollars(state, head.id, 'cash'))))
}

/** Pays an amount out of a unit's money as far as it can, borrowing on the card if it must. For other systems. */
export function payOut(ctx: Ctx, head: Person, amount: number, to: string): number {
  ensureMoney(head)
  return payFrom(ctx, head, amount, to, true)
}

interface Bill {
  id: 'essentials' | 'housing' | 'health' | 'childcare' | 'college' | 'debts' | 'support'
  parts: Array<{ to: string; amount: number }>
}

function studentLoanMonth(ctx: Ctx, person: Person, yearlyIncome: number, size: number): number {
  const { state, content } = ctx
  const money = person.money
  if (!money) return 0
  const S = content.bundle.country.money.studentLoans
  const owed = -dollars(state, person.id, 'student')
  const enrolled = person.education.status === 'college' || person.education.program !== null
  if (owed <= 0.5 || enrolled) {
    if (money.student && owed <= 0.5) tell(ctx, person, 'student_loans_paid', { years: Math.round((state.now - money.student.started) / 12) }, { significant: true, source: 'player' })
    money.student = null
    person.flags['money.grace'] = 0
    return 0
  }
  if (!money.student) {
    const waited = Number(person.flags['money.grace'] ?? 0) + 1
    person.flags['money.grace'] = waited
    if (waited < S.graceMonths) return 0
    const payment = Math.round(loanPayment(owed, content.bundle.country.economy.rates.studentLoan, S.termMonths))
    money.student = { payment, started: state.now, incomeDriven: false }
    tell(ctx, person, 'student_loans_due', { payment, total: Math.round(owed), years: S.termMonths / 12 }, { significant: true })
  }
  if (state.now - money.student.started >= S.forgivenAfterMonths) {
    move(state, WORLD.lenders, acct(person.id, 'student'), owed)
    money.student = null
    tell(ctx, person, 'loans_forgiven', { amount: Math.round(owed) }, { significant: true })
    return 0
  }
  // Income-driven repayment: never more than a share of income above a protected amount.
  const affordable = (S.incomeShare * Math.max(0, yearlyIncome - S.protectedIncome * povertyLine(ctx, size) * state.world.priceLevel)) / 12
  if (affordable < money.student.payment && !money.student.incomeDriven) {
    money.student.incomeDriven = true
    tell(ctx, person, 'loans_income_driven', { payment: Math.round(affordable), standard: money.student.payment })
  } else if (affordable >= money.student.payment) money.student.incomeDriven = false
  return Math.min(owed, money.student.payment, money.student.incomeDriven ? affordable : Infinity)
}

function budgetMonth(ctx: Ctx, head: Person, flows: Map<string, Flow>, received: Map<string, number>): void {
  const { state, content } = ctx
  const home = householdOf(state, head)
  const money = ensureMoney(head)
  if (!home) return
  const M = content.bundle.country.money
  const px = state.world.priceLevel
  const adults = unitAdults(state, head)
  const pays = paysForHome(state, head, home)
  const size = pays ? home.members.length : adults.length
  const kids = pays ? home.members.map((id) => state.people[id]).filter((p): p is Person => !!p && ageYears(p, state.now) < ADULT) : []
  const place = placeOf(content, home)
  const gross = adults.reduce((a, p) => a + (flows.get(p.id)?.gross ?? 0), 0)
  const earned = adults.reduce((a, p) => a + (flows.get(p.id)?.earned ?? 0), 0)
  let net = adults.reduce((a, p) => a + (flows.get(p.id)?.net ?? 0), 0)
  const yearly = gross * 12
  const poverty = povertyLine(ctx, size)
  const ratio = yearly / px / poverty
  const cash = acct(head.id, 'cash')

  if (pays) {
    const snap = snapBenefit(M, gross / px, earned / px, size, poverty / 12) * px
    if (snap > 0) net += move(state, WORLD.government, cash, snap)
  }

  const bills: Bill[] = []
  // What cannot be gone without. Someone living in another's home covers only their own odds and ends.
  const needs = (M.living.essentials * poverty * (place.rpp / 100) * px) / 12
  bills.push({ id: 'essentials', parts: [{ to: WORLD.merchants, amount: pays ? needs : Math.min(needs * 0.3, 0.3 * net) }] })

  const h = home.housing
  if (pays) {
    if (h.tenure === 'own') {
      const value = dollars(state, h.payer!, 'home')
      const owed = -dollars(state, h.payer!, 'mortgage')
      const parts: Bill['parts'] = []
      if (h.mortgage && owed > 0) {
        parts.push({ to: acct(h.payer!, 'mortgage'), amount: Math.min(owed, h.mortgage.payment) })
        if (h.mortgage.insurance && owed > 0.8 * value) parts.push({ to: WORLD.lenders, amount: (owed * M.housing.mortgage.insurance) / 1200 })
      } else if (h.mortgage) h.mortgage = null
      parts.push({ to: WORLD.government, amount: (value * place.propertyTax) / 1200 })
      parts.push({ to: WORLD.merchants, amount: (value * M.housing.upkeep) / 1200 })
      bills.push({ id: 'housing', parts })
    } else if (h.rent > 0) bills.push({ id: 'housing', parts: [{ to: WORLD.landlords, amount: h.rent }] })
  }

  // Health: a premium by kind of cover and typical out-of-pocket costs (an average until Milestone 5).
  let health = 0
  const offered = adults.some((a) => a.work?.job?.insured === true)
  const parentCover = !pays && parentsOf(state, head).some((p) => p.householdId === home.id && p.money?.cover === 'employer')
  for (const adult of adults) {
    const age = ageYears(adult, state.now)
    // How willing this person is to pay for cover: a stable trait, drawn once.
    const willingness = new KeyedRng(state.meta.seed).float('health.willingness', adult.id)
    const cover = parentCover && age < 26 && !offered ? { cover: 'employer' as const, cost: M.health.outOfPocket.insured } : healthCover(M, { age, offered, family: size > 1, expansionState: place.medicaid, income: yearly / px, povertyRatio: ratio, willingness })
    ensureMoney(adult).cover = cover.cover
    // A family premium is paid once, not once for each adult.
    health += adult.id !== head.id && cover.cover === 'employer' ? M.health.outOfPocket.insured : cover.cost
  }
  // Care in old age, on average: help at home, assisted living, a nursing home for some.
  for (const adult of adults) health += interpolate(M.health.lateLifeCare, ageYears(adult, state.now))
  health += kids.length * M.health.outOfPocket.child * (ratio <= M.health.medicaid.children ? 0.3 : 1)
  bills.push({ id: 'health', parts: [{ to: WORLD.merchants, amount: (health * px) / 12 }] })

  const small = kids.filter((k) => ageYears(k, state.now) < M.living.childcare.underAge).length
  if (small > 0 && adults.every((a) => a.work?.job)) bills.push({ id: 'childcare', parts: [{ to: WORLD.merchants, amount: small * Math.min((M.living.childcare.perChild * px) / 12, M.living.childcare.shareOfIncome * gross) }] })

  const debts: Bill['parts'] = []
  for (const adult of adults) {
    // The part of a year at college that neither parents nor loans cover comes out of the student's own pocket.
    const own = Number(adult.flags['edu.ownShare'] ?? 0)
    if (own > 0 && adult.education.status === 'college') bills.push({ id: 'college', parts: [{ to: WORLD.colleges, amount: (own * px) / 12 }] })
    const student = studentLoanMonth(ctx, adult, yearly, size)
    if (student > 0) debts.push({ to: acct(adult.id, 'student'), amount: student })
    const priv = -dollars(state, adult.id, 'private')
    if (priv > 0 && adult.education.status !== 'college') debts.push({ to: acct(adult.id, 'private'), amount: Math.min(priv, Math.max(50 * px, priv / 90)) })
    const card = -dollars(state, adult.id, 'card')
    if (card > 0) debts.push({ to: acct(adult.id, 'card'), amount: Math.min(card, Math.max(25 * px, card * M.credit.minimumPayment)) })
    // Child support for children who live elsewhere, when this parent pays at all.
    if (adult.flags.paysSupport === true) {
      const away = childrenOf(state, adult).find((c) => !c.died && ageYears(c, state.now) < ADULT && c.householdId !== null && c.householdId !== home.id)
      const there = away ? householdOf(state, away) : null
      const keeper = there?.housing.payer ? state.people[there.housing.payer] : undefined
      const amount = content.bundle.country.labor.childSupport.shareOfEarnings * (flows.get(adult.id)?.earned ?? 0)
      if (there && keeper && amount > 0) {
        bills.push({ id: 'support', parts: [{ to: acct(keeper.id, 'cash'), amount }] })
        received.set(there.id, (received.get(there.id) ?? 0) + amount * 12)
      }
    }
  }
  if (debts.length > 0) bills.push({ id: 'debts', parts: debts })

  // Pay in order of need. Essentials and the home may go on the card; debts may not be paid with debt.
  const order: Bill['id'][] = ['essentials', 'housing', 'health', 'childcare', 'support', 'college', 'debts']
  bills.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  let total = 0
  let missedDebt = false
  for (const bill of bills) {
    let unpaid = 0
    for (const part of bill.parts) {
      total += part.amount
      unpaid += part.amount - payFrom(ctx, head, part.amount, part.to, bill.id !== 'debts' && bill.id !== 'college', bill.id === 'essentials' || bill.id === 'housing')
    }
    if (unpaid < 1) continue
    if (bill.id === 'essentials') {
      if (money.hardship <= 0) tell(ctx, head, 'hardship', { which: pays ? 'household' : 'own' }, { significant: true })
      money.hardship = 12
    } else if (bill.id === 'housing' && h.tenure !== 'guest') {
      // Someone taken in pays what they can; what they cannot, the household that took them in absorbs.
      h.arrears += 1
      const limit = h.tenure === 'own' ? M.housing.mortgage.foreclosureAfterMonths : M.housing.evictionAfterMonths
      tell(ctx, head, 'housing_behind', { which: h.tenure === 'own' ? 'mortgage' : 'rent', months: h.arrears, left: limit - h.arrears }, { significant: true })
      // A notice that the home is at risk stops the clock for the player, who can act before it is too late.
      if (head.id === state.playerId && h.tenure === 'rent' && parentalHome(state, head) && !hasOpenDecision(state, 'system:home.behind', head)) {
        openDecision(ctx, {
          source: 'system:home.behind',
          subject: head,
          class: 'deferrable',
          deadlineMonths: 1,
          promptId: 'prompt.home.behind',
          promptData: { months: h.arrears, left: limit - h.arrears },
          options: [
            { id: 'move_back', label: plainText(ctx, 'label.home.move_back', head) },
            { id: 'stay', label: plainText(ctx, 'label.home.stay', head) },
          ],
          optional: false,
          sourceClass: 'structural',
        })
      }
    } else if (bill.id === 'debts' || bill.id === 'support') missedDebt = true
  }
  money.hardship = Math.max(0, money.hardship - 1)
  // Catching up on the home comes before anything else that money might do.
  const housing = bills.find((b) => b.id === 'housing')
  const monthly = housing ? housing.parts.reduce((a, p) => a + p.amount, 0) : 0
  if (h.arrears > 0 && pays && monthly > 0 && dollars(state, head.id, 'cash') >= monthly && housing) {
    for (const part of housing.parts) payFrom(ctx, head, part.amount, part.to, false)
    h.arrears -= 1
  }

  for (const adult of adults) {
    const m = ensureMoney(adult)
    if (missedDebt) {
      if (m.missed === 0 && adult.id === head.id) tell(ctx, head, 'payment_missed', {}, { significant: true })
      m.missed += 1
      m.credit.history *= 1 - M.credit.missedPayment
    } else {
      m.missed = 0
      m.credit.history = approach(m.credit.history, 1, M.credit.historyMonths, M.credit.historyMonths)
    }
    // A card left unpaid for long enough is written off by the lender, and stays on the file for years.
    const card = -dollars(state, adult.id, 'card')
    if (m.missed >= M.credit.chargeOffMonths && card > 0) {
      move(state, WORLD.lenders, acct(adult.id, 'card'), card)
      creditMark(state, adult)
      m.missed = 0
      tell(ctx, adult, 'debt_charged_off', { amount: Math.round(card) }, { significant: true })
    }
  }

  // Everything else: a share of what the month left over, by the standing policy.
  const level = M.living.levels.find((l) => l.id === head.policies.lifestyle) ?? M.living.levels[0]!
  // Renters of an age to buy put something aside toward a down payment, unless they spend freely.
  const saver = pays && h.tenure === 'rent' && level.spends <= 1 && head.policies.saving !== 'none' && ageYears(head, state.now) >= M.housing.savingForHome.fromAge && ageYears(head, state.now) < M.housing.savingForHome.untilAge
  let wants = Math.max(0, level.spends - (saver ? M.housing.savingForHome.share : 0)) * Math.max(0, net - total)
  // Savings are spent too, a little at a time: people with money behind them live a little better
  // for it. Once retired, the retirement accounts are drawn down as well, more as the years run out.
  const eldest = Math.max(...adults.map((a) => ageYears(a, state.now)))
  const savings = adults.reduce((a, p) => a + Math.max(0, dollars(state, p.id, 'invest')), 0) + Math.max(0, dollars(state, head.id, 'cash') - 6 * total)
  wants += (savings * interpolate(M.saving.wealthSpending, eldest)) / 12
  payFrom(ctx, head, wants, WORLD.merchants, level.spends > 1 && !missedDebt)
  if (adults.every((a) => a.work?.status === 'retired' || ageYears(a, state.now) >= M.health.medicare.age)) {
    const retirement = adults.reduce((a, p) => a + Math.max(0, dollars(state, p.id, 'retire')), 0)
    payFrom(ctx, head, (retirement * interpolate(M.saving.drawdown, eldest)) / 12, WORLD.merchants, false, true)
  }

  // Saving: beyond a buffer, cash clears the card and then, for those who invest, buys the index fund.
  const saving = M.saving.levels.find((l) => l.id === head.policies.saving) ?? M.saving.levels[0]!
  let spare = dollars(state, head.id, 'cash') - saving.bufferMonths * total
  if (spare > 0) {
    for (const adult of adults) spare -= move(state, cash, acct(adult.id, 'card'), Math.min(spare, -dollars(state, adult.id, 'card')))
    if (spare > 0 && saving.invests) move(state, cash, acct(head.id, 'invest'), spare)
  }
}

// ---------------------------------------------------------------------------------------------
// Housing
// ---------------------------------------------------------------------------------------------

function newHome(ctx: Ctx, stateId: string, tier: number, key: string): Household {
  const { content, rng } = ctx
  const names = content.bundle.country.schools
  const cfg = content.bundle.country.family.neighborhood
  const household: Household = {
    id: newId(ctx.state, 'h'),
    members: [],
    state: stateId,
    neighborhood: clamp(tier, 1, 5),
    income: 0,
    disruption: 0,
    collegeWillingness: 1,
    schools: {
      elementary: rng.pick(names.elementary, 'family.school', key, 'elementary'),
      middle: rng.pick(names.middle, 'family.school', key, 'middle'),
      high: rng.pick(names.high, 'family.school', key, 'high'),
      quality: (clamp(tier, 1, 5) - 3) * cfg.schoolQualityPerTier + cfg.schoolQualityNoise * rng.normal('family.school', key, 'quality'),
    },
    housing: { tenure: 'guest', payer: null, rent: 0, rentSet: ctx.state.now, arrears: 0, mortgage: null, shared: false },
  }
  ctx.state.households[household.id] = household
  return household
}

export { newHome as newHousehold }

function dropIfEmpty(state: GameState, home: Household): void {
  if (home.members.length === 0) delete state.households[home.id]
}

/** Why a landlord would turn this person down for a rent, or null if they would not. */
function rentRefusal(ctx: Reader, person: Person, rent: number): 'income' | 'credit' | 'record' | null {
  const H = ctx.content.bundle.country.money.housing
  const evicted = person.money?.credit.evicted
  if (evicted !== null && evicted !== undefined && ctx.state.now - evicted < H.recordYears * 12) return 'record'
  if (unitIncome(ctx, unitHead(ctx.state, person)) < H.incomeToRent * rent * 12) return 'income'
  if (person.money?.credit.opened !== null && scoreOf(ctx, person) < H.minScore) return 'credit'
  return null
}

/** Moves a person (and whoever they keep house with) into a rented place of their own. */
function rentHome(ctx: Ctx, person: Person, tier: number, shared: boolean, source: SourceClass): boolean {
  const { state, content } = ctx
  const H = content.bundle.country.money.housing
  const head = unitHead(state, person)
  const old = householdOf(state, head)
  if (!old) return false
  const paid = paysForHome(state, head, old)
  const movers = paid ? old.members.map((id) => state.people[id]!).filter(Boolean) : unitAdults(state, head)
  const rent = marketRent(ctx, old.state, tier, movers.length, shared)
  const refusal = rentRefusal(ctx, head, rent)
  if (refusal) {
    tell(ctx, person, 'rental_denied', { which: refusal, rent }, { source })
    return false
  }
  if (paid && old.housing.tenure === 'own') return false
  const home = paid ? old : newHome(ctx, old.state, tier, `${head.id}:${state.now}`)
  if (!paid) for (const mover of movers) joinHousehold(state, mover, home)
  home.neighborhood = clamp(tier, 1, 5)
  home.housing = { tenure: 'rent', payer: head.id, rent, rentSet: state.now, arrears: 0, mortgage: null, shared }
  ensureMoney(head)
  payFrom(ctx, head, rent * H.depositMonths, WORLD.landlords, true)
  tell(ctx, person, 'moved', { which: paid ? 'moved' : 'out', rent, shared, tier: home.neighborhood }, { significant: true, source })
  return true
}

/** The largest loan payment, taxes and upkeep a buyer's income supports, checked the way a lender does. */
function buyHome(ctx: Ctx, person: Person, tier: number, source: SourceClass): boolean {
  const { state, content, rng } = ctx
  const H = content.bundle.country.money.housing
  const G = H.mortgage
  const head = unitHead(state, person)
  const old = householdOf(state, head)
  if (!old) return false
  const adults = unitAdults(state, head)
  const place = placeOf(content, old)
  const price = homePrice(ctx, old.state, tier)
  const income = unitIncome(ctx, head)
  const score = scoreOf(ctx, head)
  // Parents with savings often help with a first down payment (design §7.14, "Family money").
  const helpers = adults.flatMap((a) => parentsOf(state, a)).filter((p) => !p.died && p.householdId !== old.id)
  const helperUnits = [...new Map(helpers.map((p) => [unitHead(state, p).id, unitHead(state, p)])).values()]
  const gifts = helperUnits.map((u) => {
    const spare = unitAdults(state, u).reduce((a, p) => a + Math.max(0, dollars(state, p.id, 'cash')) + Math.max(0, dollars(state, p.id, 'invest')), 0)
    return { from: u, amount: Math.round(Math.min(price * H.gift.ofPrice, spare * H.gift.ofSavings) / 100) * 100 }
  }).filter((g) => g.amount >= 1000 * state.world.priceLevel)
  const gift = gifts.reduce((a, g) => a + g.amount, 0)
  // What could be borrowed from a retirement account toward it.
  const borrowable = adults.reduce((a, p) => a + Math.min(H.retirementLoan.share * Math.max(0, dollars(state, p.id, 'retire')), H.retirementLoan.max * state.world.priceLevel), 0)
  const liquid = adults.reduce((a, p) => a + dollars(state, p.id, 'cash') + dollars(state, p.id, 'invest'), 0) + gift + borrowable
  const closing = price * H.closingCosts
  const down = Math.min(price * G.fullDown, liquid - closing - income / 24)
  const fail = (which: string, outcomeId?: string): boolean => {
    tell(ctx, person, 'mortgage_denied', { which, price, down: Math.max(0, Math.round(down)), needed: Math.round(price * G.minDown + closing) }, { significant: true, source, ...(outcomeId ? { outcomeId } : {}) })
    return false
  }
  if (down < price * G.minDown) return fail('down')
  if (score < G.minScore) return fail('credit')
  const loan = price - down
  const rate = Math.round((state.world.mortgageRate + (Math.max(0, 740 - score) / 100) * 0.5) * 100) / 100
  const payment = loanPayment(loan, rate, G.termMonths)
  const otherDebt = adults.reduce((a, p) => a + (p.money?.student?.payment ?? 0) + -dollars(state, p.id, 'card') * content.bundle.country.money.credit.minimumPayment, 0)
  const burden = (payment + (price * (place.propertyTax + H.upkeep)) / 1200 + otherDebt) / Math.max(1, income / 12)
  if (burden > G.maxDebtToIncome) return fail('income')

  // Within the rules, a lender still says no to some (design §3.2); the record is kept for "Why?".
  const A = H.approval
  const factors: OutcomeRecord['factors'] = []
  const add = (id: string, contribution: number): void => {
    if (Math.abs(contribution) >= 0.03) factors.push({ id, contribution })
  }
  add('loan_credit', (A.perScore50 * (score - 700)) / 50)
  add('loan_burden', A.perDebtPoint * (burden * 100 - 36))
  add('loan_down', down < price * 0.1 ? A.thinDown : 0)
  add('loan_group', A.byGroup[head.ethnicity] ?? 0)
  const probability = logistic(A.base + factors.reduce((a, f) => a + f.contribution, 0))
  const approved = rng.chance(probability, 'home.approval', head.id, state.now)
  const outcome: OutcomeRecord = { id: newId(state, 'out'), month: state.now, kind: 'mortgage', subjectId: person.id, model: 'logit', base: logistic(A.base), baseSource: A.source, factors, probability, context: { approved, price, rate } }
  if (person.id === state.playerId) state.outcomes[outcome.id] = outcome
  if (!approved) return fail('lender', person.id === state.playerId ? outcome.id : undefined)

  const paid = paysForHome(state, head, old)
  const movers = paid ? old.members.map((id) => state.people[id]!).filter(Boolean) : adults
  const home = paid ? old : newHome(ctx, old.state, tier, `${head.id}:${state.now}`)
  if (!paid) for (const mover of movers) joinHousehold(state, mover, home)
  for (const g of gifts) payFrom(ctx, g.from, g.amount, acct(head.id, 'cash'), false)
  // Only as much is taken from retirement savings as the cash and the gift do not cover.
  let need = down + closing - dollars(state, head.id, 'cash') - adults.filter((a) => a !== head).reduce((a, p) => a + Math.max(0, dollars(state, p.id, 'cash')), 0) - adults.reduce((a, p) => a + dollars(state, p.id, 'invest'), 0)
  for (const adult of adults) {
    if (need <= 0) break
    need -= move(state, acct(adult.id, 'retire'), acct(head.id, 'cash'), Math.min(need, H.retirementLoan.share * Math.max(0, dollars(state, adult.id, 'retire')), H.retirementLoan.max * state.world.priceLevel))
  }
  payFrom(ctx, head, down, WORLD.housing, false)
  payFrom(ctx, head, closing, WORLD.merchants, false)
  move(state, acct(head.id, 'mortgage'), WORLD.housing, loan)
  move(state, WORLD.housing, acct(head.id, 'home'), price)
  home.neighborhood = clamp(tier, 1, 5)
  home.housing = { tenure: 'own', payer: head.id, rent: 0, rentSet: state.now, arrears: 0, shared: false, mortgage: { rate, payment: Math.round(payment), originated: state.now, insurance: down < price * G.fullDown } }
  tell(ctx, person, 'home_bought', { price, down: Math.round(down), rate, payment: Math.round(payment), tier: home.neighborhood, gift }, { significant: true, source, ...(person.id === state.playerId ? { outcomeId: outcome.id } : {}) })
  return true
}

/** Sells the home: the mortgage is paid off, the costs of selling come out, the rest is cash. Returns the cash left. */
function sellHome(ctx: Ctx, home: Household, share: number): number {
  const owner = home.housing.payer
  if (!owner || home.housing.tenure !== 'own') return 0
  home.housing.mortgage = null
  return sellOwned(ctx, owner, share)
}

/** Sells whatever home a person owns: the mortgage is paid off and the rest is theirs in cash. */
function sellOwned(ctx: Ctx, owner: string, share: number): number {
  const { state } = ctx
  const value = dollars(state, owner, 'home')
  const owed = -dollars(state, owner, 'mortgage')
  const proceeds = value * share
  move(state, acct(owner, 'home'), WORLD.housing, value)
  move(state, WORLD.housing, acct(owner, 'mortgage'), Math.min(proceeds, owed))
  // What a forced sale does not cover, the lender writes off: exactly what is left, to the cent.
  move(state, WORLD.lenders, acct(owner, 'mortgage'), -dollars(state, owner, 'mortgage'))
  move(state, WORLD.housing, acct(owner, 'cash'), Math.max(0, proceeds - owed))
  return Math.max(0, proceeds - owed)
}

/** Losing the home: back to a parent's house if there is one, otherwise a room in someone else's. */
function loseHome(ctx: Ctx, home: Household, which: 'evicted' | 'foreclosed'): void {
  const { state, content } = ctx
  const H = content.bundle.country.money.housing
  const payer = home.housing.payer ? state.people[home.housing.payer] : undefined
  if (!payer) return
  // A choice about this home that is still waiting no longer applies.
  state.decisions = state.decisions.filter((d) => !(d.source === 'system:home.behind' && home.members.includes(d.subjectId)))
  if (which === 'foreclosed') sellHome(ctx, home, H.mortgage.forcedSale)
  creditMark(state, payer)
  ensureMoney(payer).credit.evicted = state.now
  const refuge = unitAdults(state, payer)
    .flatMap((a) => parentsOf(state, a))
    .map((p) => (p.died ? null : householdOf(state, p)))
    .find((h): h is Household => !!h && h.id !== home.id && h.housing.payer !== null)
  if (refuge) {
    for (const id of [...home.members]) joinHousehold(state, state.people[id]!, refuge)
    dropIfEmpty(state, home)
  } else {
    home.neighborhood = 1
    home.housing = { tenure: 'guest', shared: false, payer: payer.id, rent: Math.round(H.guestRent * marketRent(ctx, home.state, 1, home.members.length, false)), rentSet: state.now, arrears: 0, mortgage: null }
  }
  tell(ctx, payer, 'home_lost', { which, to: refuge ? 'parents' : 'room' }, { significant: true })
}

function housingMonth(ctx: Ctx, home: Household, flows: Map<string, Flow>, received: Map<string, number>): void {
  const { state, content } = ctx
  const H = content.bundle.country.money.housing
  const h = home.housing
  let income = received.get(home.id) ?? 0
  for (const id of home.members) income += (flows.get(id)?.gross ?? 0) * 12
  home.income = Math.round(income)

  // Whoever paid has died or gone: another adult takes the home on, as a tenant. A house the one
  // who left still owns is sold first, so nobody owns a home they do not live in.
  const payer = h.payer ? state.people[h.payer] : undefined
  if (!payer || payer.died || payer.householdId !== home.id) {
    if (payer && !payer.died && h.tenure === 'own') sellOwned(ctx, payer.id, 1 - H.sellingCosts)
    const next = home.members
      .map((id) => state.people[id]!)
      .filter((p) => p && ageYears(p, state.now) >= ADULT)
      .sort((a, b) => a.born - b.born)[0]
    const head = next ? unitHead(state, next) : undefined
    home.housing = head
      ? { tenure: 'rent', shared: false, payer: head.id, rent: marketRent(ctx, home.state, home.neighborhood, home.members.length, false), rentSet: state.now, arrears: 0, mortgage: null }
      : { tenure: 'guest', shared: false, payer: null, rent: 0, rentSet: state.now, arrears: 0, mortgage: null }
    return
  }
  if (h.tenure === 'rent' && state.now - h.rentSet >= 12) {
    const rent = marketRent(ctx, home.state, home.neighborhood, home.members.length, h.shared)
    if (Math.abs(rent - h.rent) > 0.06 * h.rent) tell(ctx, payer, 'rent_changed', { from: h.rent, to: rent, which: rent > h.rent ? 'up' : 'down' })
    h.rent = rent
    h.rentSet = state.now
  }
  if (h.tenure === 'own' && h.arrears >= H.mortgage.foreclosureAfterMonths) loseHome(ctx, home, 'foreclosed')
  else if (h.tenure === 'rent' && h.arrears >= H.evictionAfterMonths) loseHome(ctx, home, 'evicted')
  // Most people who fall behind on the rent and have family to go to move in with them before it
  // comes to a court date. Other people do; the player has the action and the warnings.
  else if (h.tenure === 'rent' && h.arrears >= 1 && payer.id !== state.playerId && home.members.length === unitAdults(state, payer).length) {
    const refuge = parentalHome(state, payer)
    if (refuge && ctx.rng.chance(H.doubleUp, 'home.doubleUp', payer.id, state.now)) {
      for (const id of [...home.members]) joinHousehold(state, state.people[id]!, refuge)
      dropIfEmpty(state, home)
    }
  }
}

/** The tier of home a person would look for: the best their income comfortably carries. */
function tierWithinMeans(ctx: Reader, person: Person, shared: boolean, buying: boolean): number {
  const home = householdOf(ctx.state, person)
  if (!home) return 1
  const income = unitIncome(ctx, unitHead(ctx.state, person))
  let tier = 1
  for (let t = 2; t <= 5; t++) {
    const cost = buying ? homePrice(ctx, home.state, t) * 0.085 : marketRent(ctx, home.state, t, 1, shared) * 12
    if (cost <= income * 0.28) tier = t
  }
  return tier
}

/**
 * Yearly chances that this person, of their own accord, moves out of a family home or buys a
 * home. Other people act on them; AI players, who act once a year, use them too.
 */
export function homeChances(state: GameState, content: Prepared, person: Person): { moveOut: number; buy: number } {
  const H = content.bundle.country.money.housing
  const home = householdOf(state, person)
  const age = ageYears(person, state.now)
  if (!home || age < ADULT || person.education.status === 'k12') return { moveOut: 0, buy: 0 }
  const head = unitHead(state, person)
  const pays = paysForHome(state, head, home)
  const working = person.work?.job !== null && person.work?.job !== undefined
  return {
    moveOut: !pays && working ? interpolate(H.movesOut, age) : 0,
    buy: pays && home.housing.tenure === 'rent' && (working || person.work?.status === 'retired') ? interpolate(H.buys, age) : 0,
  }
}

function livingChoices(ctx: Ctx, person: Person): void {
  const { state, content, rng } = ctx
  if ((state.now - person.born) % 12 !== 6 || unitHead(state, person).id !== person.id) return
  const chances = homeChances(state, content, person)
  if (chances.moveOut > 0 && rng.chance(chances.moveOut, 'home.moveOut', person.id, state.now)) {
    const shared = ageYears(person, state.now) < 28
    rentHome(ctx, person, tierWithinMeans(ctx, person, shared, false), shared, 'npc')
  } else if (chances.buy > 0 && rng.chance(chances.buy, 'home.buy', person.id, state.now)) {
    buyHome(ctx, person, tierWithinMeans(ctx, person, false, true), 'npc')
  }
}

/** One month of money for everyone (design §5.2, phase 6). */
export function moneyMonth(ctx: Ctx): void {
  const { state } = ctx
  const people = livingPeople(state)
  const month = monthOf(state.now)
  const flows = new Map<string, Flow>()
  const received = new Map<string, number>()
  if (month === 0) {
    for (const p of people) {
      if (!p.money) continue
      p.money.taxDue = { ...p.money.tax }
      p.money.tax = { wages: 0, other: 0, withheld: 0 }
    }
  }
  for (const p of people) payMonth(ctx, p, flows)
  if (month === 3) for (const p of people) settleTaxes(ctx, p)
  for (const p of people) returnsMonth(ctx, p)
  for (const p of people) if (ageYears(p, state.now) >= ADULT && unitHead(state, p).id === p.id) budgetMonth(ctx, p, flows, received)
  for (const id of Object.keys(state.households).sort()) {
    const home = state.households[id]
    if (home) housingMonth(ctx, home, flows, received)
  }
  for (const p of people) if (p.id !== state.playerId && !p.died) livingChoices(ctx, p)
}

// ---------------------------------------------------------------------------------------------
// Death, separation, and adults who enter already grown
// ---------------------------------------------------------------------------------------------

/**
 * Returns what the player inherits, in dollars of the day, so the news can follow the death.
 * What a person leaves (design §7.11). A partner they lived with keeps everything. Otherwise the
 * home is sold, debts are settled out of the estate, federal student loans die with the borrower,
 * and what remains is shared among living children. Called before the dead leave their household.
 */
export function settleEstate(ctx: Ctx, dead: Person): number {
  let toPlayer = 0
  const { state, content } = ctx
  const id = dead.id
  const partner = unitAdults(state, dead).find((a) => a.id !== id)
  const home = householdOf(state, dead)
  move(state, WORLD.lenders, acct(id, 'student'), -dollars(state, id, 'student'))
  if (partner) {
    for (const kind of ASSETS) move(state, acct(id, kind), acct(partner.id, kind), dollars(state, id, kind))
    for (const kind of DEBTS) move(state, acct(partner.id, kind), acct(id, kind), -dollars(state, id, kind))
    if (home && home.housing.payer === id) home.housing.payer = partner.id
    return 0
  }
  if (home && home.housing.payer === id && home.housing.tenure === 'own') home.housing = { ...home.housing, tenure: 'rent', payer: null, mortgage: null, shared: false }
  // Any home the dead still own is sold, wherever they were living.
  sellOwned(ctx, id, 1 - content.bundle.country.money.housing.sellingCosts)
  for (const kind of ['invest', 'retire'] as const) move(state, acct(id, kind), acct(id, 'cash'), dollars(state, id, kind))
  for (const kind of ['card', 'private', 'mortgage'] as const) {
    const owed = -dollars(state, id, kind)
    move(state, acct(id, 'cash'), acct(id, kind), Math.min(owed, Math.max(0, dollars(state, id, 'cash'))))
    move(state, WORLD.lenders, acct(id, kind), -dollars(state, id, kind))
  }
  const estate = dollars(state, id, 'cash')
  if (estate <= 0) {
    move(state, WORLD.lenders, acct(id, 'cash'), -estate)
    return 0
  }
  const heirs = childrenOf(state, dead).filter((c) => !c.died)
  if (heirs.length === 0) {
    move(state, acct(id, 'cash'), WORLD.government, estate)
    return 0
  }
  const each = Math.floor((estate * 100) / heirs.length) / 100
  for (const heir of heirs) {
    ensureMoney(heir)
    move(state, acct(id, 'cash'), acct(unitHead(state, heir).id, 'cash'), each)
    if (heir.id === state.playerId && each >= 100 * state.world.priceLevel) toPlayer = Math.round(each)
  }
  move(state, acct(id, 'cash'), WORLD.government, dollars(state, id, 'cash'))
  return toPlayer
}

/** When a couple part: whoever kept the books hands over half of what could be divided. */
export function divideMoney(ctx: Ctx, a: Person, b: Person, stays: Person): void {
  const { state } = ctx
  const keeper = a.id < b.id ? a : b
  const other = keeper === a ? b : a
  ensureMoney(other)
  for (const kind of ['cash', 'invest'] as const) move(state, acct(keeper.id, kind), acct(other.id, kind), Math.max(0, dollars(state, keeper.id, kind)) / 2)
  move(state, acct(other.id, 'card'), acct(keeper.id, 'card'), -dollars(state, keeper.id, 'card') / 2)
  // The home, and what is owed on it, go with whoever stays in it.
  if (stays.id !== keeper.id) {
    move(state, acct(keeper.id, 'home'), acct(stays.id, 'home'), dollars(state, keeper.id, 'home'))
    move(state, acct(stays.id, 'mortgage'), acct(keeper.id, 'mortgage'), -dollars(state, keeper.id, 'mortgage'))
  }
  const home = householdOf(state, stays)
  if (home && home.housing.payer !== null) home.housing.payer = stays.id
}

/** Gives a household of adults who enter the simulation already grown a home and the savings and debts they would have. */
export function settleHousehold(ctx: Ctx, home: Household, adults: Person[]): void {
  const { state, content, rng } = ctx
  const M = content.bundle.country.money
  const W = M.wealthAtStart
  const head = unitHead(state, adults[0]!)
  const px = state.world.priceLevel
  const income = Math.max(12000, adults.reduce((a, p) => a + currentIncome(ctx, p), 0) / px)
  const age = Math.max(...adults.map((p) => ageYears(p, state.now)))
  const group = content.bundle.country.people.groups.find((g) => g.id === head.ethnicity)
  const z = rng.normal('home.wealth', head.id)
  const median = interpolate(W.byAge, age) * dpow(income / W.medianIncome, W.incomeElasticity) * (group?.wealth ?? 1)
  // About one household in ten owes more than it owns.
  const worth = (z < -1.25 ? -0.2 * income * rng.float('home.debt', head.id) : median * dexp(W.logSd * z)) * px
  const O = M.housing.ownsAtStart
  const owns = worth > 0 && rng.chance(logistic(O.base + O.perAgeYear * (age - 30) + O.perIncomeLog * dlog(income / W.medianIncome) + (group?.owning ?? 0)), 'home.owns', head.id)
  for (const adult of adults) ensureMoney(adult)
  let rest = worth
  if (owns) {
    const price = homePrice(ctx, home.state, home.neighborhood)
    const equity = clamp(worth * 0.6, 0.05 * price, price)
    const loan = price - equity
    const rate = Math.round(state.world.mortgageRate * 100) / 100
    move(state, WORLD.housing, acct(head.id, 'home'), price)
    move(state, acct(head.id, 'mortgage'), WORLD.housing, loan)
    home.housing = { tenure: 'own', shared: false, payer: head.id, rent: 0, rentSet: state.now, arrears: 0, mortgage: loan > 0 ? { rate, payment: Math.round(loanPayment(loan, rate, 300)), originated: state.now - 60, insurance: false } : null }
    rest = worth - equity
  } else {
    home.housing = { tenure: 'rent', shared: false, payer: head.id, rent: marketRent(ctx, home.state, home.neighborhood, Math.max(1, home.members.length), false), rentSet: state.now - rng.int(12, 'home.rentSet', head.id), arrears: 0, mortgage: null }
  }
  if (rest > 0) {
    move(state, WORLD.markets, acct(head.id, 'cash'), rest * W.cash)
    for (const adult of adults) move(state, WORLD.markets, acct(adult.id, 'retire'), (rest * W.retirement) / adults.length)
    move(state, WORLD.markets, acct(head.id, 'invest'), rest * (1 - W.cash - W.retirement))
  } else {
    move(state, WORLD.markets, acct(head.id, 'cash'), 0.03 * income * px)
    move(state, acct(head.id, 'card'), WORLD.merchants, Math.min(-rest + 0.03 * income * px, 0.3 * income * px))
  }
  // People with savings and people in debt run their lives differently; their policies follow.
  for (const adult of adults) defaultMoneyPolicies(ctx, adult, z)
}

/** In-character defaults for spending and saving: the conscientious save more, and so do those raised to. */
export function defaultMoneyPolicies(ctx: Ctx, person: Person, lean = 0): void {
  const M = ctx.content.bundle.country.money
  const thrift = 0.6 * (person.traits.conscientiousness ?? 0) + 0.5 * lean + 0.7 * ctx.rng.normal('money.thrift', person.id)
  person.policies.lifestyle = thrift > 1.6 ? 'frugal' : thrift > 0.6 ? 'modest' : thrift > -1.0 ? 'comfortable' : 'free'
  person.policies.saving = thrift > 1.5 ? 'heavy' : thrift > 0.7 ? 'steady' : thrift > -0.4 ? 'match' : 'none'
  if (!M.living.levels.some((l) => l.id === person.policies.lifestyle)) person.policies.lifestyle = M.living.default
  if (!M.saving.levels.some((l) => l.id === person.policies.saving)) person.policies.saving = M.saving.default
}

// ---------------------------------------------------------------------------------------------
// What the player can do
// ---------------------------------------------------------------------------------------------

const RENT_CHOICES: Array<{ id: string; tier: number; shared: boolean }> = [
  { id: 'shared', tier: 2, shared: true },
  { id: 'cheap', tier: 1, shared: false },
  { id: 'ordinary', tier: 3, shared: false },
  { id: 'good', tier: 4, shared: false },
]

registerAction('home.rent', {
  available(state, content, person) {
    const home = householdOf(state, person)
    if (!home || ageYears(person, state.now) < ADULT) return null
    const head = unitHead(state, person)
    const pays = paysForHome(state, head, home)
    if (pays && home.housing.tenure === 'own') return null
    const ctx = reader(state, content)
    const size = pays ? home.members.length : 1
    return {
      label: plainText(ctx, pays ? 'label.act.move' : 'label.act.move_out', person),
      section: 'money',
      costs: ['a month of rent as a deposit'],
      choices: RENT_CHOICES.map((c) => ({ id: c.id, label: plainText(ctx, 'label.home.rent_option', person, { which: c.id, rent: marketRent(ctx, home.state, c.tier, size, c.shared) }) })),
    }
  },
  perform(ctx, person, choice) {
    const option = RENT_CHOICES.find((c) => c.id === choice)
    if (option) rentHome(ctx, person, option.tier, option.shared, 'player')
  },
})

const BUY_CHOICES: Array<{ id: string; tier: number }> = [
  { id: 'starter', tier: 1 },
  { id: 'modest', tier: 2 },
  { id: 'ordinary', tier: 3 },
  { id: 'good', tier: 4 },
  { id: 'fine', tier: 5 },
]

registerAction('home.buy', {
  available(state, content, person) {
    const home = householdOf(state, person)
    if (!home || ageYears(person, state.now) < ADULT) return null
    if (paysForHome(state, unitHead(state, person), home) && home.housing.tenure === 'own') return null
    const ctx = reader(state, content)
    const H = content.bundle.country.money.housing
    return {
      label: plainText(ctx, 'label.act.buy_home', person),
      section: 'money',
      costs: [`at least ${Math.round(H.mortgage.minDown * 1000) / 10}% down, plus about ${Math.round(H.closingCosts * 100)}% in costs`],
      choices: BUY_CHOICES.map((c) => ({ id: c.id, label: plainText(ctx, 'label.home.buy_option', person, { which: c.id, price: homePrice(ctx, home.state, c.tier) }) })),
    }
  },
  perform(ctx, person, choice) {
    const option = BUY_CHOICES.find((c) => c.id === choice)
    if (option) buyHome(ctx, person, option.tier, 'player')
  },
})

registerAction('home.sell', {
  available(state, content, person) {
    const home = householdOf(state, person)
    if (!home || home.housing.tenure !== 'own' || home.housing.payer !== unitHead(state, person).id) return null
    const ctx = reader(state, content)
    const value = dollars(state, home.housing.payer, 'home')
    return { label: plainText(ctx, 'label.act.sell_home', person, { value: Math.round(value) }), section: 'money', costs: [`about ${Math.round(content.bundle.country.money.housing.sellingCosts * 100)}% of the price in costs`] }
  },
  perform(ctx, person) {
    const { state, content } = ctx
    const home = householdOf(state, person)
    if (!home) return
    const value = dollars(state, home.housing.payer!, 'home')
    const left = sellHome(ctx, home, 1 - content.bundle.country.money.housing.sellingCosts)
    home.housing = { tenure: 'rent', shared: false, payer: home.housing.payer, rent: marketRent(ctx, home.state, home.neighborhood, home.members.length, false), rentSet: state.now, arrears: 0, mortgage: null }
    tell(ctx, person, 'home_sold', { price: Math.round(value), left: Math.round(left), rent: home.housing.rent }, { significant: true, source: 'player' })
  },
})

function parentalHome(state: GameState, person: Person): Household | null {
  const own = householdOf(state, person)
  for (const parent of parentsOf(state, person)) {
    const home = parent.died ? null : householdOf(state, parent)
    if (home && home.id !== own?.id && home.housing.payer !== null) return home
  }
  return null
}

function moveBack(ctx: Ctx, person: Person): void {
  const { state } = ctx
  const old = householdOf(state, person)
  const refuge = parentalHome(state, person)
  // Only someone who pays for a rented home can give it up; they take their own unit and its children.
  if (!old || !refuge || old.housing.tenure === 'own' || old.housing.payer !== unitHead(state, person).id) return
  const unit = unitAdults(state, unitHead(state, person)).map((a) => a.id)
  const movers = old.members.filter((id) => {
    const p = state.people[id]!
    return unit.includes(id) || (ageYears(p, state.now) < ADULT && [p.motherId, p.fatherId].some((m) => m !== null && unit.includes(m)))
  })
  for (const id of movers) joinHousehold(state, state.people[id]!, refuge)
  dropIfEmpty(state, old)
  tell(ctx, person, 'moved', { which: 'back', rent: 0, shared: false, tier: refuge.neighborhood }, { significant: true, source: 'player' })
}

registerSystemDecision('home.behind', {
  resolve(ctx, _decision, subject, optionId) {
    if (optionId === 'move_back') moveBack(ctx, subject)
  },
  weights(state, content) {
    const p = content.bundle.country.money.housing.doubleUp
    return [p, 1 - p]
  },
})

registerAction('home.move_back', {
  available(state, content, person) {
    const home = householdOf(state, person)
    if (!home || ageYears(person, state.now) < ADULT || home.housing.tenure === 'own' || home.housing.payer !== person.id || home.members.length > 1) return null
    if (!parentalHome(state, person)) return null
    return { label: plainText(reader(state, content), 'label.act.move_back', person), section: 'money' }
  },
  perform(ctx, person) {
    moveBack(ctx, person)
  },
})

/** Everything a unit owns and owes, for the view and the batch tool, in dollars of the day. */
export function unitWorth(state: GameState, person: Person): number {
  return unitAdults(state, unitHead(state, person)).reduce((a, p) => a + netWorth(state, p.id), 0)
}

export { KINDS }
export { balance }
