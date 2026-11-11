/**
 * The perceived world (design §3.5, §11). The interface receives a PlayerView and nothing else:
 * hidden numbers leave the engine only as words, as observed behavior, or as the kind of record a
 * real person would hold (a report card, a test score, a bill). Imperfect information is enforced
 * here, at the boundary.
 */

import { ageInYears, monthName, yearOf } from './core/time'
import type { Prepared } from './content/prepare'
import { gradeName, hsGpa, letterGrade } from './country/us/education'
import { povertyLine } from './country/us/family'
import { scoreOf } from './country/us/household'
import { jobTitle, retirementBenefit } from './country/us/work'
import { ageYears, householdOf, parentsOf, relationOf, siblingsOf } from './people'
import { KINDS, dollars as held, netWorth } from './systems/money'
import { player, type Cost, type GameState, type Person } from './state'
import { availableActions } from './systems/actions'
import { describe } from './systems/perception'

export interface FeedItem {
  id: string
  kind: string
  dateText: string
  age: number
  text: string
  significant: boolean
  /** Present when the player can ask why this happened. */
  whyId?: string
  /** Present while this entry is a decision still waiting for an answer. */
  decisionId?: string
}

export interface DecisionView {
  id: string
  blocking: boolean
  prompt: string
  /** e.g. "Decide by the end of March 2061", or empty for blocking decisions. */
  dueText: string
  options: Array<{ id: string; label: string; costs: string[] }>
}

export interface PolicyView {
  current: string
  canChange: boolean
  lockedReason: string
  /** `hoursPerWeek` is absent for policies that are not about time. */
  options: Array<{ id: string; label: string; description: string; hoursPerWeek?: number }>
}

export interface WorkView {
  /** One line: "Senior electrician at Alder Electric". Empty before working age. */
  line: string
  /** Records a person would hold: the pay slip, the terms of the job. */
  facts: Array<{ label: string; value: string }>
  history: Array<{ title: string; employer: string; years: string; ended: string }>
  effort: PolicyView | null
  search: PolicyView | null
}

export interface MoneyView {
  /** Multiply an amount by this to see it in the dollars of the year the life began. */
  deflator: number
  baseYear: number
  /** How things stand, in a sentence. */
  line: string
  /** Balances as a bank or a lender would state them, in dollars of the day; debts are negative. */
  accounts: Array<{ label: string; amount: number }>
  netWorth: number
  /** What comes in and goes out in a month, in dollars of the day. */
  monthly: Array<{ label: string; amount: number }>
  facts: Array<{ label: string; value: string }>
  /** The economy as the news reports it. */
  economy: string
  lifestyle: PolicyView | null
  saving: PolicyView | null
}

export interface FamilyMember {
  id: string
  name: string
  /** "mother", "brother"… */
  relation: string
  /** "34", or "died in 2051 at 71". */
  age: string
  /** What the character knows of them now, in a few words. */
  notes: string[]
}

export interface SchoolView {
  /** One line: "Fourth grade at Oakdale Elementary". Empty when not enrolled. */
  line: string
  /** Highest level completed, in words. */
  attained: string
  reportCard: { title: string; gpa: string; subjects: Array<{ label: string; letter: string }> } | null
  /** Records a person would hold: exact, because the school hands them over. */
  facts: Array<{ label: string; value: string }>
}

export interface ActionView {
  id: string
  label: string
  section: string
  costs: string[]
  choices: Array<{ id: string; label: string }>
}

export interface PlayerView {
  phase: 'alive' | 'ended'
  seed: string
  date: { month: string; year: number }
  place: string
  person: { name: string; firstName: string; sex: 'male' | 'female'; age: number; ageText: string; stageLabel: string }
  status: { health: string; conditions: string[]; fitness: string; strength: string; strain: string }
  feed: FeedItem[]
  decisions: DecisionView[]
  routine: { activity: PolicyView; study: PolicyView | null }
  family: { money: string; members: FamilyMember[] }
  school: SchoolView
  work: WorkView
  money: MoneyView
  actions: ActionView[]
  advance: { allowed: boolean; blockedReason: string }
  death: { age: number; dateText: string } | null
}

function ageText(months: number): string {
  if (months < 1) return 'newborn'
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} old`
  return `${Math.floor(months / 12)} years old`
}

function dollars(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
}

function costText(cost: Cost | undefined, currency: string): string[] {
  if (!cost) return []
  const out: string[] = []
  if (cost.hoursPerWeek) out.push(`${cost.hoursPerWeek} hour${cost.hoursPerWeek === 1 ? '' : 's'} a week`)
  if (cost.money !== undefined) out.push(cost.money === 0 ? 'no cost to you' : dollars(cost.money, currency))
  if (cost.energy && cost.energy !== 'none') out.push(cost.energy === 'low' ? 'takes a little energy' : cost.energy === 'moderate' ? 'takes some energy' : 'takes a lot of energy')
  return out
}

const ATTAINED: Record<string, string> = {
  less_than_hs: 'No diploma',
  high_school: 'High school diploma',
  some_college: 'Some college, no degree',
  associate: 'Associate degree',
  bachelor: "Bachelor's degree",
  graduate: 'Graduate degree',
}

/** What the character knows of a relative: where they are and what they are doing. */
function memberNotes(state: GameState, content: Prepared, self: Person, other: Person): string[] {
  if (other.died) return []
  const notes: string[] = []
  const age = ageYears(other, state.now)
  notes.push(other.householdId !== null && other.householdId === self.householdId ? 'lives with you' : 'lives elsewhere')
  const edu = other.education
  if (edu.status === 'k12' && edu.grade !== null) notes.push(`in ${gradeName(edu.grade)}`)
  else if (edu.status === 'college' && edu.college) notes.push(`at ${edu.college.name}`)
  else if (age >= 18 && other.work) {
    const job = other.work.job
    notes.push(job ? `${job.hoursPerWeek < 30 ? 'part-time ' : ''}${jobTitle(content, job.occupation, job.level)}` : other.work.status === 'retired' ? 'retired' : other.work.status === 'unemployed' ? 'out of work' : 'at home')
  }
  return notes
}

function familyView(state: GameState, content: Prepared, self: Person): PlayerView['family'] {
  const members: FamilyMember[] = []
  for (const other of [...parentsOf(state, self), ...siblingsOf(state, self)]) {
    const at = other.died?.at ?? state.now
    const age = ageInYears(other.born, at)
    members.push({
      id: other.id,
      name: `${other.name.first} ${other.name.family}`,
      relation: relationOf(self, other),
      age: other.died ? `died in ${yearOf(other.died.at)} at ${age}` : age < 1 ? 'a baby' : String(age),
      notes: memberNotes(state, content, self, other),
    })
  }
  // Money at home in the words a member of the household would use, not a figure.
  const home = self.householdId ? state.households[self.householdId] : undefined
  const ratio = home ? home.income / state.world.priceLevel / povertyLine({ state, content }, home.members.length) : 0
  const money = ratio < 1 ? 'There is not enough money at home.' : ratio < 2 ? 'Money is tight at home.' : ratio < 4 ? 'The household gets by.' : ratio < 7 ? 'The household is comfortable.' : 'The household is well off.'
  return { money, members }
}

function schoolView(state: GameState, content: Prepared, self: Person): SchoolView {
  const cfg = content.bundle.country.education
  const currency = content.bundle.country.currency
  const edu = self.education
  const facts: SchoolView['facts'] = []
  let line = ''
  if (edu.status === 'k12' && edu.grade !== null && edu.school) {
    const name = gradeName(edu.grade)
    line = `${name[0]!.toUpperCase()}${name.slice(1)} at ${edu.school.name}`
    if (edu.grade >= 9) facts.push({ label: 'Courses', value: cfg.k12.courseLevels.find((c) => c.id === edu.courseLevel)?.label ?? '' })
  } else if (edu.status === 'college' && edu.college) {
    const c = edu.college
    const tier = cfg.tiers.find((t) => t.id === c.tier)
    line = `${c.name}${c.partTime ? ', part-time' : ''}`
    facts.push({ label: 'Major', value: cfg.majors.find((m) => m.id === c.major)?.label ?? '' })
    facts.push({ label: 'Credits', value: `${Math.round(c.credits)} of ${tier ? cfg.college.creditsFor[tier.credential] : ''}` })
    if (c.gradedCredits > 0) facts.push({ label: 'College GPA', value: (c.gradePoints / c.gradedCredits).toFixed(2) + (c.probation ? ' (on probation)' : '') })
    facts.push({ label: 'Cost this year', value: dollars(c.netPrice * state.world.priceLevel, currency) })
    facts.push({ label: 'Your parents pay', value: dollars(c.parentsPay * state.world.priceLevel, currency) })
    if (c.unmetNeed > 0) facts.push({ label: 'Still uncovered', value: dollars(c.unmetNeed * state.world.priceLevel, currency) })
  } else if (edu.plan) {
    line = `Starting at ${edu.plan.name} in September`
  }
  const gpa = hsGpa(self)
  if (gpa !== null) facts.push({ label: 'High school GPA', value: gpa.toFixed(2) })
  if (edu.test) facts.push({ label: cfg.test.name, value: `${edu.test.verbal + edu.test.math} (${edu.test.verbal} reading and writing, ${edu.test.math} math)` })
  const program = edu.program ? content.bundle.country.labor.programs.find((p) => p.id === edu.program!.id) : undefined
  if (program && edu.program) {
    line = `${program.label[0]!.toUpperCase()}${program.label.slice(1)}`
    facts.push({ label: 'Finishes', value: `${monthName(edu.program.ends)} ${yearOf(edu.program.ends)}` })
  }
  const owed = -(held(state, self.id, 'student') + held(state, self.id, 'private'))
  if (owed > 0) facts.push({ label: 'Student loans', value: dollars(owed, currency) })
  if (self.credentials.length > 0) facts.push({ label: 'Qualifications', value: self.credentials.map((c) => c.replace(/_/g, ' ')).join(', ') })

  const report = edu.lastReport
  return {
    line,
    attained: edu.status === 'not_modeled' ? '' : (ATTAINED[edu.level] ?? ''),
    reportCard:
      report && edu.status === 'k12'
        ? {
            title: `Last report card, ${gradeName(report.grade)}`,
            gpa: report.gpa.toFixed(2),
            subjects: cfg.k12.subjects.map((s) => ({ label: s.label, letter: letterGrade(report.points[s.id] ?? 0) })),
          }
        : null,
    facts,
  }
}

function policyView(levels: Array<{ id: string; label: string; description: string }>, current: string, canChange: boolean, lockedReason: string): PolicyView {
  return { current, canChange, lockedReason, options: levels.map((l) => ({ id: l.id, label: l.label, description: l.description })) }
}

function yearsText(months: number): string {
  if (months < 12) return `${Math.max(1, months)} month${months === 1 ? '' : 's'}`
  const years = Math.round(months / 12)
  return `${years} year${years === 1 ? '' : 's'}`
}

function workView(state: GameState, content: Prepared, self: Person, alive: boolean): WorkView {
  const L = content.bundle.country.labor
  const currency = content.bundle.country.currency
  const work = self.work
  const age = ageYears(self, state.now)
  const facts: WorkView['facts'] = []
  let line = ''
  if (work?.job) {
    const job = work.job
    const title = jobTitle(content, job.occupation, job.level)
    line = `${title[0]!.toUpperCase()}${title.slice(1)} at ${job.employer}`
    facts.push({ label: 'Pay', value: `${dollars(job.salary, currency)} a year before tax` })
    facts.push({ label: 'Hours', value: `${job.hoursPerWeek} a week${job.hoursPerWeek < 30 ? ' (part-time)' : ''}` })
    facts.push({ label: 'There since', value: `${monthName(job.started)} ${yearOf(job.started)}` })
    facts.push({ label: 'You report to', value: job.manager })
    facts.push({ label: 'Health insurance', value: job.insured ? 'through the job' : 'not offered' })
    facts.push({ label: 'Retirement plan', value: job.pension ? 'a pension' : job.match > 0 ? `employer matches up to ${(job.match * 100).toFixed(1)}% of pay` : 'none' })
    if (job.warned) facts.push({ label: 'Standing', value: 'your last review was a warning' })
  } else if (work?.status === 'retired') line = 'Retired'
  else if (work?.status === 'unemployed') {
    line = `Out of work${work.since !== null ? ` for ${yearsText(state.now - work.since)}` : ''}, and looking`
    if (work.insurance && state.now <= work.insurance.until) facts.push({ label: 'Unemployment benefit', value: `${dollars(work.insurance.weekly, currency)} a week until ${monthName(work.insurance.until)} ${yearOf(work.insurance.until)}` })
  } else if (work && age >= 16) line = 'Not working, and not looking'
  if (work?.target && work.status !== 'retired') facts.push({ label: 'Looking for work as', value: content.occupations.get(work.target)?.title ?? '' })
  if (work?.benefit) facts.push({ label: 'Social Security', value: `${dollars(work.benefit.monthly * state.world.priceLevel, currency)} a month` })
  else if (work && age >= 55) facts.push({ label: 'Social Security if claimed now', value: age >= content.bundle.country.tax.socialSecurity.earliestAge ? `${dollars(retirementBenefit({ state, content }, self) * state.world.priceLevel, currency)} a month` : `from ${content.bundle.country.tax.socialSecurity.earliestAge}` })
  if (work && work.pension > 0) facts.push({ label: 'Pension earned so far', value: `${dollars(work.pension * state.world.priceLevel, currency)} a month` })
  const history = [...(work?.history ?? [])].reverse().map((h) => ({
    title: content.occupations.get(h.occupation)?.title ?? h.occupation,
    employer: h.employer,
    years: `${yearOf(h.from)}–${yearOf(h.to)}`,
    ended: h.why === 'layoffs' || h.why === 'closed' || h.why === 'sudden' ? 'laid off' : h.why === 'dismissed' ? 'let go' : h.why === 'quit' ? 'left' : h.why === 'retired' ? 'retired' : h.why === 'died' ? 'to the end' : 'moved on',
  }))
  const can = alive && age >= 16 && work?.status !== 'retired'
  const locked = !alive || age >= 16 ? '' : 'You are too young to work. That changes at 16.'
  return {
    line,
    facts,
    history,
    effort: work?.job ? policyView(L.performance.levels, self.policies.effort, can, locked) : null,
    search: age >= 14 && work?.status !== 'retired' ? policyView(L.search.levels, self.policies.search, can, locked) : null,
  }
}

const ACCOUNT_LABELS: Record<string, string> = {
  cash: 'Bank account',
  invest: 'Index fund',
  retire: 'Retirement account',
  home: "Home, at today's prices",
  card: 'Credit card',
  student: 'Federal student loans',
  private: 'Private student loans',
  mortgage: 'Mortgage',
}

const COVER_LABELS: Record<string, string> = { employer: 'through work', public: 'Medicaid', marketplace: 'a marketplace plan', medicare: 'Medicare', none: 'none' }

function moneyView(state: GameState, content: Prepared, self: Person, alive: boolean): MoneyView {
  const M = content.bundle.country.money
  const currency = content.bundle.country.currency
  const w = state.world
  const age = ageYears(self, state.now)
  const home = householdOf(state, self)
  const accounts: MoneyView['accounts'] = []
  for (const kind of KINDS) {
    const amount = Math.round(held(state, self.id, kind))
    if (amount !== 0) accounts.push({ label: ACCOUNT_LABELS[kind] ?? kind, amount })
  }
  const worth = Math.round(netWorth(state, self.id))
  const monthly: MoneyView['monthly'] = []
  const job = self.work?.job
  if (job) monthly.push({ label: 'Pay before tax', amount: Math.round(job.salary / 12) })
  if (self.work?.benefit) monthly.push({ label: 'Social Security', amount: Math.round(self.work.benefit.monthly * w.priceLevel) })
  const mine = home?.housing.payer === self.id
  if (home && mine && home.housing.tenure === 'own' && home.housing.mortgage) monthly.push({ label: 'Mortgage payment', amount: -home.housing.mortgage.payment })
  else if (home && mine && home.housing.rent > 0) monthly.push({ label: 'Rent', amount: -home.housing.rent })
  if (self.money?.student) monthly.push({ label: 'Student loan payment', amount: -self.money.student.payment })

  const facts: MoneyView['facts'] = []
  if (home) facts.push({ label: 'Home', value: mine ? (home.housing.tenure === 'own' ? 'you own it' : home.housing.tenure === 'rent' ? 'rented' : "a room in someone else's home") : 'you live in a home someone else pays for' })
  if (home && mine && home.housing.arrears > 0) facts.push({ label: 'Behind on the home', value: `${home.housing.arrears} month${home.housing.arrears === 1 ? '' : 's'}` })
  if (home && mine && home.housing.mortgage) facts.push({ label: 'Mortgage rate', value: `${home.housing.mortgage.rate.toFixed(2)}%, fixed` })
  if (self.money && self.money.credit.opened !== null) facts.push({ label: 'Credit score', value: String(Math.round(scoreOf({ state, content }, self) / 5) * 5) })
  else if (age >= 18) facts.push({ label: 'Credit score', value: 'no credit history yet' })
  if (self.money && age >= 18) facts.push({ label: 'Health cover', value: COVER_LABELS[self.money.cover] ?? '' })

  const liquid = held(state, self.id, 'cash') + held(state, self.id, 'invest')
  const debt = -(held(state, self.id, 'card') + held(state, self.id, 'private'))
  const line =
    age < 16 || !self.money
      ? ''
      : self.money.hardship > 0
        ? 'There is not enough money for the basics.'
        : self.money.missed > 0 || (home && mine && home.housing.arrears > 0)
          ? 'You are behind on your bills.'
          : debt > 1000 * w.priceLevel && liquid < debt
            ? 'You are carrying debt that costs you every month.'
            : liquid < 500 * w.priceLevel
              ? 'You have almost nothing put by.'
              : worth > 0
                ? 'You are paying your way and have something behind you.'
                : 'You are paying your way.'
  const can = alive && age >= 18
  const locked = !alive || age >= 18 ? '' : "Money is your parents' business for now. From 18 it is yours."
  return {
    deflator: 1 / w.priceLevel,
    baseYear: content.bundle.country.startYear,
    line,
    accounts,
    netWorth: worth,
    monthly,
    facts,
    economy:
      age < 14
        ? ''
        : `${w.regime === 'recession' || w.regime === 'severe' ? 'The country is in a recession. ' : ''}Unemployment is ${w.unemployment.toFixed(1)}%, prices are rising ${w.inflation.toFixed(1)}% a year, and a thirty-year mortgage costs ${w.mortgageRate.toFixed(1)}%.`,
    lifestyle: age >= 16 ? policyView(M.living.levels, self.policies.lifestyle, can, locked) : null,
    saving: age >= 16 ? policyView(M.saving.levels, self.policies.saving, can, locked) : null,
  }
}

export function perceive(state: GameState, content: Prepared): PlayerView {
  const self = player(state)
  const at = self.died?.at ?? state.now
  const months = at - self.born
  const age = ageInYears(self.born, at)
  const body = content.bundle.body
  const study = content.bundle.country.education.k12.study
  const currency = content.bundle.country.currency
  const stage = content.bundle.stages.find((s) => s.id === content.stageFor(age))
  const alive = state.phase === 'alive'

  const openById = new Map(state.decisions.filter((d) => d.subjectId === self.id).map((d) => [d.id, d]))
  const feed: FeedItem[] = []
  for (const entry of state.log) {
    if (entry.hidden || !entry.text) continue
    const decisionId = entry.fact.kind === 'decision_opened' ? String(entry.fact.data.decision) : undefined
    feed.push({
      id: entry.id,
      kind: entry.fact.kind,
      dateText: `${monthName(entry.month)} ${yearOf(entry.month)}`,
      age: entry.age,
      text: entry.text,
      significant: entry.fact.significant,
      ...(entry.fact.outcomeId ? { whyId: entry.fact.outcomeId } : {}),
      ...(decisionId && openById.has(decisionId) ? { decisionId } : {}),
    })
  }

  const decisions: DecisionView[] = [...openById.values()].map((d) => ({
    id: d.id,
    blocking: d.class === 'blocking',
    prompt: d.prompt,
    dueText: d.deadline === null ? '' : `Decide by the end of ${monthName(d.deadline)} ${yearOf(d.deadline)}`,
    options: d.options.map((o) => ({ id: o.id, label: o.label, costs: costText(o.cost, currency) })),
  }))

  const conditions: string[] = []
  for (const id of Object.keys(state.processes).sort()) {
    const inst = state.processes[id]!
    if (inst.subjectId !== self.id) continue
    const status = content.processes.get(inst.def)?.stageById.get(inst.stage)?.status
    if (status) conditions.push(status)
  }

  const blocking = decisions.find((d) => d.blocking)
  const canMove = age >= body.activityChoiceFromAge && alive
  const enrolled = self.education.status === 'k12' || self.education.status === 'college'
  const canStudy = age >= study.choiceFromAge && alive

  return {
    phase: state.phase,
    seed: state.meta.seed,
    date: { month: monthName(at), year: yearOf(at) },
    place: content.bundle.country.states.find((s) => s.id === (self.householdId ? state.households[self.householdId]?.state : undefined))?.name ?? content.bundle.country.name,
    person: { name: `${self.name.first} ${self.name.family}`, firstName: self.name.first, sex: self.sex, age, ageText: ageText(months), stageLabel: stage?.label ?? '' },
    status: {
      health: conditions[0] ?? describe(state, content, self, 'stamina'),
      conditions,
      fitness: describe(state, content, self, 'fitness'),
      strength: describe(state, content, self, 'strength'),
      strain: describe(state, content, self, 'strain'),
    },
    feed,
    decisions,
    routine: {
      activity: {
        current: self.policies.activity,
        canChange: canMove,
        lockedReason: canMove || !alive ? '' : `You are too young to set your own routine. That changes at ${body.activityChoiceFromAge}.`,
        options: body.activityLevels.map((a) => ({ id: a.id, label: a.label, description: a.description, hoursPerWeek: a.hoursPerWeek })),
      },
      study: enrolled
        ? {
            current: self.policies.study,
            canChange: canStudy,
            lockedReason: canStudy || !alive ? '' : `For now your parents and your teacher decide how much work you do. From ${study.choiceFromAge} it is up to you.`,
            options: study.levels.map((l) => ({ id: l.id, label: l.label, description: l.description, hoursPerWeek: l.hoursPerWeek })),
          }
        : null,
    },
    family: familyView(state, content, self),
    school: schoolView(state, content, self),
    work: workView(state, content, self, alive),
    money: moneyView(state, content, self, alive),
    actions: alive ? availableActions(state, content, self).map((a) => ({ id: a.id, label: a.label, section: a.section, costs: a.costs ?? [], choices: a.choices ?? [] })) : [],
    advance: {
      allowed: alive && !blocking,
      blockedReason: !alive ? 'This life has ended.' : blocking ? 'Something needs your answer first.' : '',
    },
    death: self.died ? { age, dateText: `${monthName(self.died.at)} ${yearOf(self.died.at)}` } : null,
  }
}
