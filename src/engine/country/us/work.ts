/**
 * Careers and work (design §7.13). Occupations are data; this file is the logic around them: who
 * qualifies for what, how a search turns into an offer, what a job pays, how it goes month by
 * month, and how it ends. Employers are fictional and generated when someone is hired. A
 * struggling employer shows signs before it lays people off, which is how most jobs are lost.
 *
 * Everyone runs through the same code. A standing policy says whether a person is looking, an
 * offer arrives as a decision, and other people answer theirs in character at once.
 */

import type { OccupationDef } from '../../content/country-schema'
import { approach, clamp, dexp, dpow, interpolate, logistic, logit } from '../../core/dmath'
import { KeyedRng } from '../../core/rng'
import { monthOf } from '../../core/time'
import { emitFact, type Ctx, type SourceClass } from '../../context'
import type { Prepared } from '../../content/prepare'
import { ageYears, educationRank, educationZ, householdOf, parentsOf, relationOf } from '../../people'
import { livingPeople, newId, player, type GameState, type Job, type Org, type OutcomeRecord, type Person, type Scalar, type Work } from '../../state'
import { registerAction } from '../../systems/actions'
import { hasOpenDecision, openDecision, plainText, registerSystemDecision } from '../../systems/decisions'
import { slack } from '../../systems/economy'
import { blankMoney } from '../../systems/money'
import { claimingFactor, primaryInsuranceAmount } from './tax'
import { tellPlayer } from './news'

type Occ = OccupationDef
type Offer = NonNullable<Work['offer']>

function laborOf(content: Prepared) {
  return content.bundle.country.labor
}

/** A context for reading state where no step is in progress (the view, automatic choices). */
function reader(state: GameState, content: Prepared): Ctx {
  return { state, content, rng: new KeyedRng(state.meta.seed), narrator: null, facts: [], interrupted: false }
}

function tell(ctx: Ctx, person: Person, kind: string, data: Record<string, Scalar>, options: { significant?: boolean; source?: SourceClass; outcomeId?: string; hidden?: boolean } = {}): void {
  emitFact(
    ctx,
    { kind, subject: person, data, significant: options.significant ?? false, ...(options.outcomeId ? { outcomeId: options.outcomeId } : {}) },
    { sourceClass: options.source ?? 'structural', hidden: options.hidden ?? false },
  )
}

export function occupationOf(content: Prepared, id: string): Occ {
  const occ = content.occupations.get(id)
  if (!occ) throw new Error(`Unknown occupation '${id}'`)
  return occ
}

/** "senior electrician", "apprentice plumber", "cashier". */
export function jobTitle(content: Prepared, occupation: string, level: number): string {
  const occ = content.occupations.get(occupation)
  if (!occ) return occupation
  if (level < 0) return occ.trainee?.title ?? occ.title
  return `${laborOf(content).ladder[Math.min(level, laborOf(content).ladder.length - 1)]?.prefix ?? ''}${occ.title}`
}

export function ensureMoney(person: Person): NonNullable<Person['money']> {
  return (person.money ??= blankMoney())
}

export function ensureWork(ctx: Ctx, person: Person): Work {
  if (person.work) return person.work
  const P = laborOf(ctx.content).pay
  // Standing in the pay of whatever they do: part ability and temperament, part the home they grew
  // up in beyond what it did for their schooling (Heckman 2006; Chetty et al. 2014), part luck.
  // Fixed for life.
  const aptitude = ((person.aptitudes.verbal ?? 0) + (person.aptitudes.quantitative ?? 0)) / 2
  const parents = parentsOf(ctx.state, person)
  const background = parents.length ? parents.reduce((a, p) => a + educationZ(p.education.level), 0) / parents.length : 0
  const merit = (0.7 * aptitude + 0.4 * (person.traits.conscientiousness ?? 0) + P.background * background) / dpow(0.49 + 0.16 + P.background * P.background + 0.3, 0.5)
  person.work = {
    status: 'none',
    job: null,
    skills: {},
    months: {},
    history: [],
    since: null,
    laidOff: false,
    insurance: null,
    target: null,
    offer: null,
    payLevel: P.personalSd * (P.fit * merit + Math.sqrt(1 - P.fit * P.fit) * ctx.rng.normal('work.payLevel', person.id)),
    earnings: [],
    yearWages: 0,
    benefit: null,
    pension: 0,
    pensionYears: 0,
  }
  ensureMoney(person)
  return person.work
}

/** How well a person's abilities suit a line of work, as a z-score. */
export function fitFor(person: Person, occ: Occ): number {
  const ability = occ.math * (person.aptitudes.quantitative ?? 0) + (1 - occ.math) * (person.aptitudes.verbal ?? 0)
  const withPeople = occ.people * (0.6 * (person.traits.extraversion ?? 0) + 0.4 * (person.traits.agreeableness ?? 0))
  return 0.8 * ability + 0.35 * withPeople
}

function monthsWorked(work: Work): number {
  let total = 0
  for (const id in work.months) total += work.months[id]!
  return total
}

/** Whether the credential a line of work needs must be held before starting, rather than earned on the job. */
function needsCredentialFirst(content: Prepared, occ: Occ): boolean {
  return occ.credential !== undefined && (content.programByCredential.has(occ.credential) || !occ.trainee)
}

/** Whether a person could be hired into a line of work today. */
export function qualifies(state: GameState, content: Prepared, person: Person, occ: Occ): boolean {
  const age = ageYears(person, state.now)
  if (age < 16 || (age < 18 && !occ.youth)) return false
  if (educationRank(person.education.level) < educationRank(occ.education)) return false
  if (occ.credential && person.credentials.includes(occ.credential)) return true
  if (needsCredentialFirst(content, occ)) return false
  // A degree has to be in the right field, where the work asks for one.
  if (occ.majors && !occ.majors.includes(String(person.flags['edu.major'] ?? ''))) return false
  if (occ.experienceYears > 0 && monthsWorked(person.work ?? ({ months: {} } as Work)) < occ.experienceYears * 12) return false
  return true
}

/** How likely a person is to look for each line of work they qualify for. */
export function occupationWeights(state: GameState, content: Prepared, person: Person): Array<{ occ: Occ; weight: number }> {
  const S = laborOf(content).search
  const out: Array<{ occ: Occ; weight: number }> = []
  const rank = educationRank(person.education.level)
  for (const occ of laborOf(content).occupations) {
    if (!qualifies(state, content, person, occ)) continue
    const typed = dpow(2 * (person.sex === 'female' ? occ.female : 1 - occ.female) + 0.02, S.sexTyping)
    // People mostly look for work at the level of their schooling, and return to what they know.
    const below = dpow(0.3, Math.max(0, rank - educationRank(occ.education)))
    const known = 1 + 10 * (person.work?.skills[occ.id] ?? 0)
    const qualified = occ.credential && person.credentials.includes(occ.credential) ? 12 : 1
    out.push({ occ, weight: occ.employment * typed * below * known * qualified * dexp(0.5 * fitFor(person, occ)) })
  }
  return out
}

function pickOccupation(ctx: Ctx, person: Person, ...key: Array<string | number>): Occ | null {
  const options = occupationWeights(ctx.state, ctx.content, person)
  const index = ctx.rng.weighted(options.map((o) => o.weight), 'work.pick', person.id, ...key)
  return index < 0 ? null : options[index]!.occ
}

/** The rung a person would be hired at: the highest their months and skill in the work allow. */
function levelFor(content: Prepared, person: Person, occ: Occ): number {
  if (occ.trainee && occ.credential && !person.credentials.includes(occ.credential)) return -1
  const ladder = laborOf(content).ladder
  const months = person.work?.months[occ.id] ?? 0
  const skill = person.work?.skills[occ.id] ?? 0
  let level = occ.experienceYears > 0 ? 1 : 0
  for (let i = level + 1; i < ladder.length; i++) if (months >= ladder[i]!.months && skill >= ladder[i]!.skill) level = i
  return level
}

/** Whether school takes most of the week. Certificates are studied around a job; graduate programs are not. */
function studying(person: Person): boolean {
  const edu = person.education
  return edu.status === 'k12' || (edu.status === 'college' && !edu.college?.partTime) || (edu.program !== null && edu.program.ends - edu.program.started > 14)
}

function hoursFor(ctx: Ctx, person: Person, occ: Occ): number {
  if (studying(person)) return person.education.status === 'k12' ? 14 : 20
  if (person.flags['work.partTime'] === true) return 22
  return ctx.rng.chance(occ.partTime * 0.5, 'work.hours', person.id, ctx.state.now) ? 24 : occ.hours
}

/** Yearly pay, in the dollars of the day, for a person in a job at given hours. `luck` is a z-score particular to the offer. */
export function salaryFor(ctx: Pick<Ctx, 'state' | 'content'>, person: Person, occ: Occ, level: number, hours: number, orgPay: number, luck: number): number {
  const { state, content } = ctx
  const L = laborOf(content)
  const home = householdOf(state, person)
  const place = content.bundle.country.states.find((s) => s.id === home?.state)
  const rung = level < 0 ? (occ.trainee?.pay ?? L.ladder[0]!.pay) : L.ladder[Math.min(level, L.ladder.length - 1)]!.pay
  const regional = dpow((place?.rpp ?? 100) / 100, content.bundle.country.economy.wages.regional)
  const standing = Math.sqrt(1 - L.pay.offerNoise * L.pay.offerNoise) * (person.work?.payLevel ?? 0) + L.pay.offerNoise * luck
  // The spread narrows for trainees: an apprentice's wage is set by the program.
  const personal = dexp(occ.spread * (level < 0 ? 0.3 : 1) * standing)
  const share = hours / occ.hours
  const fullTime = occ.pay * rung * regional * state.world.wageIndex * orgPay * personal
  const pay = fullTime * share * (hours < 30 ? L.pay.partTimeHourly : 1)
  const floor = Math.max(7.25, place?.minWage ?? 7.25) * state.world.priceLevel * hours * 52
  return Math.round(Math.max(pay, floor))
}

function makeOffer(ctx: Ctx, person: Person, occ: Occ, outside: boolean): Offer {
  const { state, content, rng } = ctx
  const L = laborOf(content)
  const names = L.employers.names
  const key = [person.id, state.now, outside ? 1 : 0] as const
  const sectorNames = names.bySector[occ.sector] ?? ['Company']
  const employer = `${rng.pick(names.first, 'work.org.first', ...key)} ${rng.pick(sectorNames, 'work.org.second', ...key)}`
  const orgPay = dexp(L.employers.paySd * rng.normal('work.org.pay', ...key))
  const level = levelFor(content, person, occ)
  const current = person.work?.job
  const hours = current && outside && !studying(person) ? Math.max(current.hoursPerWeek, occ.hours * (current.hoursPerWeek < 30 ? 0.6 : 1)) : hoursFor(ctx, person, occ)
  let salary = salaryFor(ctx, person, occ, level, hours, orgPay, rng.normal('work.offer.luck', ...key))
  // Nobody is approached with an offer below what they already make for the same work.
  if (current && outside && current.occupation === occ.id) {
    const raise = L.search.outsideRaise[0] + (L.search.outsideRaise[1] - L.search.outsideRaise[0]) * rng.float('work.offer.raise', ...key)
    salary = Math.max(salary, Math.round(((current.salary * hours) / current.hoursPerWeek) * (1 + raise)))
  }
  const [lo, hi] = content.bundle.country.money.saving.matchRate
  return {
    occupation: occ.id,
    level,
    employer,
    sector: occ.sector,
    orgPay,
    salary,
    hoursPerWeek: hours,
    insured: hours >= 30 && rng.chance(occ.insured, 'work.offer.insured', ...key),
    match: rng.chance(occ.retirement, 'work.offer.plan', ...key) ? lo + (hi - lo) * rng.float('work.offer.match', ...key) : 0,
    pension: occ.pension,
    outside,
  }
}

/** The chance that one application ends in an offer, with the factors behind it (design §3.2). */
export function offerChance(ctx: Pick<Ctx, 'state' | 'content'>, person: Person, occ: Occ): { base: number; probability: number; factors: OutcomeRecord['factors'] } {
  const { state, content } = ctx
  const S = laborOf(content).search
  const work = person.work
  const factors: OutcomeRecord['factors'] = []
  const add = (id: string, contribution: number): void => {
    if (Math.abs(contribution) >= 0.03) factors.push({ id, contribution })
  }
  const sector = content.bundle.country.economy.sectors.find((s) => s.id === occ.sector)
  add('job_market', S.perPointOfUnemployment * slack(content, state.world, (occ.cyclical + (sector?.cyclical ?? 1)) / 2))
  const index = state.world.sectors[occ.sector]?.index ?? 1
  add('job_sector', S.sector * (index - 1))
  add('job_experience', S.experience * ((work?.skills[occ.id] ?? 0) - 0.25))
  if (!work || work.history.length === 0) add('job_first', S.firstJob)
  const out = work && work.since !== null && !work.job ? state.now - work.since : 0
  // The penalty for a gap grows for about two years and then stops growing (Kroft et al. 2013).
  add('job_gap', S.perSixMonthsOut * clamp((out - 6) / 6, 0, 3))
  add('job_age', S.perDecadeOver50 * Math.max(0, (ageYears(person, state.now) - 50) / 10))
  add('job_interview', S.interview * (0.6 * (person.traits.extraversion ?? 0) + 0.4 * (person.traits.agreeableness ?? 0)))
  add('job_fit', S.fit * fitFor(person, occ))
  add('job_callbacks', S.callbacks.byGroup[person.ethnicity] ?? 0)
  const base = S.offerPerApplication
  return { base, probability: logistic(logit(base) + factors.reduce((a, f) => a + f.contribution, 0)), factors }
}

function searchLevel(content: Prepared, person: Person) {
  const S = laborOf(content).search
  return S.levels.find((l) => l.id === person.policies.search) ?? S.levels[0]!
}

function effortLevel(content: Prepared, person: Person) {
  const P = laborOf(content).performance
  return P.levels.find((l) => l.id === person.policies.effort) ?? P.levels[0]!
}

/** Hours a week the job really takes, given how hard the person pushes. */
export function workHours(content: Prepared, person: Person): number {
  const job = person.work?.job
  return job ? job.hoursPerWeek * effortLevel(content, person).hours : 0
}

function startJob(ctx: Ctx, person: Person, offer: Offer, source: SourceClass): void {
  const { state, content, rng } = ctx
  const work = ensureWork(ctx, person)
  const L = laborOf(content)
  const first = work.history.length === 0 && !work.job
  const outFor = work.since !== null ? state.now - work.since : 0
  if (work.job) endJob(ctx, person, 'moved')
  const org: Org = {
    id: newId(state, 'org'),
    name: offer.employer,
    sector: offer.sector,
    pay: offer.orgPay,
    health: 'sound',
    since: state.now,
    until: state.now,
    risk: L.employers.trouble.perMonth[person.education.level],
  }
  state.orgs[org.id] = org
  work.job = {
    occupation: offer.occupation,
    level: offer.level,
    orgId: org.id,
    employer: offer.employer,
    manager: rng.pick(L.employers.names.managers, 'work.manager', person.id, state.now),
    started: state.now,
    hoursPerWeek: offer.hoursPerWeek,
    salary: offer.salary,
    insured: offer.insured,
    match: offer.match,
    pension: offer.pension,
    payIndex: state.world.wageIndex,
    performance: 0.5,
    warned: false,
  }
  work.status = 'employed'
  work.since = null
  work.laidOff = false
  work.insurance = null
  work.offer = null
  const money = ensureMoney(person)
  if (money.credit.opened === null) money.credit.opened = state.now
  const title = jobTitle(content, offer.occupation, offer.level)
  tell(
    ctx,
    person,
    'hired',
    { which: first ? 'first' : offer.outside ? 'moved' : 'new', title, employer: offer.employer, salary: offer.salary, hours: offer.hoursPerWeek, partTime: offer.hoursPerWeek < 30, trainee: offer.level < 0, insured: offer.insured, manager: work.job.manager, months: outFor },
    { significant: true, source },
  )
  if (!first && !offer.outside && outFor > 0) tellFamily(ctx, person, 'parent_job_found', { months: outFor }, false)
}

/** News of a parent's job for a child who lives with them. */
function tellFamily(ctx: Ctx, person: Person, kind: string, data: Record<string, Scalar>, significant: boolean): void {
  const self = player(ctx.state)
  if (person.id === self.id || person.householdId === null || person.householdId !== self.householdId) return
  const relation = relationOf(self, person)
  if (relation !== 'mother' && relation !== 'father') return
  tellPlayer(ctx, kind, person, data, significant && ageYears(self, ctx.state.now) < 18)
}

function endJob(ctx: Ctx, person: Person, why: string): void {
  const work = person.work
  const job = work?.job
  if (!work || !job) return
  work.history.push({ occupation: job.occupation, employer: job.employer, from: job.started, to: ctx.state.now, why })
  if (work.history.length > 40) work.history.shift()
  work.job = null
}

type Loss = 'layoffs' | 'closed' | 'sudden' | 'dismissed'

function loseJob(ctx: Ctx, person: Person, which: Loss): void {
  const { state, content } = ctx
  const work = person.work!
  const job = work.job!
  const U = laborOf(content).unemploymentInsurance
  const tenure = state.now - job.started
  const home = householdOf(state, person)
  const place = content.bundle.country.states.find((s) => s.id === home?.state)
  // Unemployment insurance is for people let go through no fault of their own, with enough work behind them.
  const covered = which !== 'dismissed' && monthsWorked(work) >= U.minMonths
  const weekly = covered ? Math.round(Math.min((place?.uiMax ?? 400) * state.world.priceLevel, (U.replacement * job.salary) / 52)) : 0
  const warned = state.orgs[job.orgId]?.health !== 'sound' || job.warned
  const title = jobTitle(content, job.occupation, job.level)
  const employer = job.employer
  endJob(ctx, person, which)
  work.since = state.now
  work.laidOff = true
  work.insurance = weekly > 0 ? { weekly, until: state.now + Math.round(U.weeks / 4.345) } : null
  work.status = searchLevel(content, person).applications > 0 ? 'unemployed' : 'home'
  if (home) home.disruption += 0.25
  tell(ctx, person, 'job_lost', { which, title, employer, months: tenure, benefit: weekly, weeks: weekly > 0 ? U.weeks : 0, warned }, { significant: true, source: which === 'dismissed' ? 'player' : 'structural' })
  tellFamily(ctx, person, 'parent_job_lost', { months: 0 }, true)
}

/**
 * Monthly chances of stepping out of work and of coming back. Someone with a partner in work at
 * home can afford a spell out; someone alone mostly cannot, and comes back sooner.
 */
function stepOdds(state: GameState, content: Prepared, person: Person): { out: number; back: number } {
  const P = laborOf(content).participation
  const partner = person.partner ? state.people[person.partner.id] : undefined
  // Supported: a partner at home in work, or a home someone else pays for.
  const home = person.householdId ? state.households[person.householdId] : undefined
  const supported = (!!partner && !partner.died && partner.householdId === person.householdId && !!partner.work?.job) || (!!home && home.housing.payer !== null && home.housing.payer !== person.id && home.housing.payer !== partner?.id)
  return { out: P.stepOut[person.sex] * (supported ? 1 : P.stepOut.alone), back: P.stepBack * (supported ? 1 : P.stepOut.backAlone) }
}

/** Steps out of work for a while: caring for someone, illness, a spell at home. */
function stepOut(ctx: Ctx, person: Person, work: Work): void {
  if (work.job) endJob(ctx, person, 'home')
  work.status = 'home'
  work.since = ctx.state.now
  work.laidOff = false
  work.insurance = null
  work.offer = null
  person.policies.search = 'none'
  person.flags['work.home'] = true
}

/** The dead do nothing: a job ends with the person who held it. */
export function stopWork(ctx: Ctx, dead: Person): void {
  const work = dead.work
  if (!work) return
  if (work.job) endJob(ctx, dead, 'died')
  if (work.status === 'employed') work.status = 'home'
  work.offer = null
  work.insurance = null
}

/** The monthly benefit, in start-year dollars, that claiming now would give. */
export function retirementBenefit(ctx: Pick<Ctx, 'state' | 'content'>, person: Person): number {
  const tax = ctx.content.bundle.country.tax
  const work = person.work
  if (!work) return 0
  return Math.round(primaryInsuranceAmount(tax, work.earnings) * claimingFactor(tax, ctx.state.now - person.born))
}

function claimBenefit(ctx: Ctx, person: Person): void {
  const work = person.work
  if (!work || work.benefit) return
  const monthly = retirementBenefit(ctx, person)
  work.benefit = { claimedAt: ctx.state.now, monthly }
  tell(ctx, person, 'benefit_claimed', { monthly: Math.round(monthly * ctx.state.world.priceLevel), age: ageYears(person, ctx.state.now) }, { significant: true, source: 'player' })
}

function retire(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  const work = ensureWork(ctx, person)
  const job = work.job
  const title = job ? jobTitle(content, job.occupation, job.level) : ''
  const longest = Object.entries(work.months).sort((a, b) => b[1] - a[1])[0]
  if (job) endJob(ctx, person, 'retired')
  work.status = 'retired'
  work.offer = null
  work.insurance = null
  person.policies.search = 'none'
  state.decisions = state.decisions.filter((d) => !(d.subjectId === person.id && d.source === 'system:work.offer'))
  tell(ctx, person, 'retired', { title, years: Math.round(monthsWorked(work) / 12), longest: longest ? occupationOf(content, longest[0]).title : '', pension: Math.round(work.pension * state.world.priceLevel) }, { significant: true, source: 'player' })
  const S = content.bundle.country.tax.socialSecurity
  // Other people claim when they stop, if they are old enough; the player is asked.
  if (person.id !== state.playerId && ageYears(person, state.now) >= S.earliestAge) claimBenefit(ctx, person)
}

// ---------------------------------------------------------------------------------------------
// The month
// ---------------------------------------------------------------------------------------------

function growSkill(ctx: Ctx, person: Person, work: Work, occ: Occ, hours: number): void {
  const K = laborOf(ctx.content).skill
  const level = work.skills[occ.id] ?? startingSkill(ctx.content, work, occ)
  const rate = K.perMonth * (hours / 40) * dexp(K.aptitude * fitFor(person, occ)) * dpow(Math.max(0, 1 - level), K.power)
  work.skills[occ.id] = clamp(level + rate, 0, 1)
  work.months[occ.id] = (work.months[occ.id] ?? 0) + 1
}

/** Related work gives a head start: part of the best skill held in the same sector. */
function startingSkill(content: Prepared, work: Work, occ: Occ): number {
  let best = 0
  for (const id in work.skills) if (content.occupations.get(id)?.sector === occ.sector) best = Math.max(best, work.skills[id]!)
  return laborOf(content).skill.related * best
}

function fadeSkills(content: Prepared, work: Work): void {
  const K = laborOf(content).skill
  const current = work.job?.occupation
  for (const id in work.skills) {
    if (id === current) continue
    // Unused skill fades toward a floor that long practice raises (design §7.5).
    const floor = K.retained * work.skills[id]! * Math.min(1, (work.months[id] ?? 0) / 120)
    work.skills[id] = approach(work.skills[id]!, floor, K.fadeMonths, K.fadeMonths)
  }
}

function review(ctx: Ctx, person: Person, work: Work, job: Job): void {
  const { state, content, rng } = ctx
  const L = laborOf(content)
  const P = L.performance
  const occ = occupationOf(content, job.occupation)
  const goingRate = state.world.wageIndex / job.payIndex - 1
  const raise = Math.max(0, goingRate + (L.pay.merit / 100) * (job.performance - L.pay.typicalPerformance))
  job.salary = Math.round(job.salary * (1 + raise))
  job.payIndex = state.world.wageIndex
  const which = job.performance > 0.68 ? 'strong' : job.performance > 0.54 ? 'good' : job.performance > P.warnBelow ? 'adequate' : 'poor'
  const wasWarned = job.warned
  job.warned = which === 'poor'
  // A review is told when it says something new: the first at a job, a change of verdict, or a warning.
  const verdict = `${job.started}:${which}`
  if (person.flags['work.lastReview'] !== verdict || which === 'poor') {
    tell(ctx, person, 'review', { which, raise: Math.round(raise * 1000) / 10, salary: job.salary, employer: job.employer, manager: job.manager, warned: job.warned, again: wasWarned && job.warned }, { significant: which === 'poor', source: 'player' })
  }
  person.flags['work.lastReview'] = verdict
  if (job.level < 0 || job.performance < 0.5) return

  const next = L.ladder[job.level + 1]
  const skill = work.skills[occ.id] ?? 0
  if (next && (work.months[occ.id] ?? 0) >= next.months && skill >= next.skill) {
    if (rng.chance(P.promote * (0.5 + job.performance), 'work.promote', person.id, state.now)) {
      job.salary = Math.round((job.salary * next.pay) / L.ladder[job.level]!.pay)
      job.level += 1
      tell(ctx, person, 'promoted', { which: 'rung', title: jobTitle(content, job.occupation, job.level), salary: job.salary, employer: job.employer }, { significant: true, source: 'player' })
    }
    return
  }
  // Being put in charge: the next line of work that opens with experience and pays more than this one.
  const total = monthsWorked(work)
  const above = L.occupations
    .filter((o) => o.experienceYears > 0 && o.experienceYears * 12 <= total && o.pay > occ.pay * 1.05 && educationRank(person.education.level) >= educationRank(o.education))
    .sort((a, b) => a.pay - b.pay)[0]
  const drive = dexp(0.4 * (person.traits.extraversion ?? 0) + 0.4 * (person.traits.conscientiousness ?? 0))
  if (above && job.level >= 1 && rng.chance(Math.min(0.5, P.toManagement * (0.5 + job.performance) * drive), 'work.manage', person.id, state.now)) {
    const org = state.orgs[job.orgId]
    job.occupation = above.id
    job.level = 1
    job.salary = Math.max(Math.round(job.salary * 1.08), salaryFor(ctx, person, above, 1, job.hoursPerWeek, org?.pay ?? 1, 0))
    tell(ctx, person, 'promoted', { which: 'management', title: jobTitle(content, job.occupation, job.level), salary: job.salary, employer: job.employer }, { significant: true, source: 'player' })
  }
}

function employedMonth(ctx: Ctx, person: Person, work: Work, job: Job): void {
  const { state, content, rng } = ctx
  const L = laborOf(content)
  const P = L.performance
  const occ = occupationOf(content, job.occupation)
  const age = ageYears(person, state.now)
  const tenure = state.now - job.started
  const isPlayer = person.id === state.playerId

  growSkill(ctx, person, work, occ, workHours(content, person))
  const target = clamp(
    0.5 +
      P.fit * fitFor(person, occ) +
      P.conscientiousness * (person.traits.conscientiousness ?? 0) +
      P.skill * ((work.skills[occ.id] ?? 0) - 0.4) +
      effortLevel(content, person).effort +
      P.strain * person.strain +
      // One draw per job and year: the projects, the manager, the luck of it.
      P.noise * rng.normal('work.year', person.id, job.started, Math.floor(tenure / 12)),
    0,
    1,
  )
  job.performance = approach(job.performance, target, P.months, P.months)
  if (job.pension) {
    work.pensionYears += 1 / 12
    work.pension = (content.bundle.country.money.pension.perYear * work.pensionYears * (job.salary / state.world.priceLevel)) / 12
  }

  // Training on the job ends with the credential.
  if (job.level < 0 && occ.trainee && (work.months[occ.id] ?? 0) >= occ.trainee.months) {
    if (occ.credential && !person.credentials.includes(occ.credential)) person.credentials.push(occ.credential)
    job.level = 0
    job.salary = Math.max(job.salary, salaryFor(ctx, person, occ, 0, job.hoursPerWeek, state.orgs[job.orgId]?.pay ?? 1, 0))
    job.payIndex = state.world.wageIndex
    tell(ctx, person, 'promoted', { which: 'qualified', title: jobTitle(content, job.occupation, 0), salary: job.salary, employer: job.employer }, { significant: true, source: 'player' })
  }

  // How a job ends without the worker choosing it.
  const org = state.orgs[job.orgId]
  const T = L.employers.trouble
  const exposed = ((tenure < 12 ? L.separations.firstYear : 1) * (1.4 - 0.8 * job.performance)) / (1 + tenure / 12 / L.separations.tenureShield)
  if (org?.health === 'layoffs' && rng.chance(Math.min(1, T.laidOffPerMonth * exposed), 'work.laidOff', person.id, state.now)) return loseJob(ctx, person, 'layoffs')
  if (rng.chance(L.separations.suddenPerMonth * exposed, 'work.sudden', person.id, state.now)) return loseJob(ctx, person, 'sudden')
  if (job.warned && job.performance < P.warnBelow && rng.chance(P.dismissedPerMonth, 'work.dismissed', person.id, state.now)) return loseJob(ctx, person, 'dismissed')

  if (!isPlayer) {
    // Other people walk out or retire of their own accord; the player has actions for both.
    if (rng.chance(interpolate(L.separations.quitPerMonth, age), 'work.quit', person.id, state.now)) return quit(ctx, person)
    if (rng.chance(retireChance(content, age) / 12, 'work.retire', person.id, state.now)) return retire(ctx, person)
  }

  if (tenure > 0 && tenure % 12 === 0) review(ctx, person, work, job)

  // Hearing of something better.
  const level = searchLevel(content, person)
  if (!work.offer && level.outside > 0 && job.level >= 0 && rng.chance(Math.min(0.5, interpolate(L.search.outsideOffer, age) * level.outside), 'work.outside', person.id, state.now)) {
    const wanted = work.target ? content.occupations.get(work.target) : undefined
    const other = wanted && wanted.id !== occ.id && qualifies(state, content, person, wanted) ? wanted : rng.chance(0.3, 'work.outside.switch', person.id, state.now) ? pickOccupation(ctx, person, 'outside', state.now) : occ
    // Nobody is approached with a job that pays less by the hour, unless it is the work they are after.
    const offer = other ? makeOffer(ctx, person, other, true) : null
    if (offer && (offer.occupation === work.target || offer.salary / offer.hoursPerWeek > (job.salary / job.hoursPerWeek) * 1.02)) presentOffer(ctx, person, work, offer)
  }
}

function retireChance(content: Prepared, age: number): number {
  const R = laborOf(content).participation.retire
  return age < R[0]![0] ? 0 : interpolate(R, age)
}

function quit(ctx: Ctx, person: Person): void {
  const work = person.work
  const job = work?.job
  if (!work || !job) return
  const title = jobTitle(ctx.content, job.occupation, job.level)
  const employer = job.employer
  const months = ctx.state.now - job.started
  endJob(ctx, person, 'quit')
  work.since = ctx.state.now
  work.laidOff = false
  work.status = searchLevel(ctx.content, person).applications > 0 ? 'unemployed' : 'home'
  tell(ctx, person, 'job_quit', { title, employer, months }, { significant: true, source: 'player' })
}

function presentOffer(ctx: Ctx, person: Person, work: Work, offer: Offer): void {
  const { content } = ctx
  work.offer = offer
  const current = work.job
  const title = jobTitle(content, offer.occupation, offer.level)
  openDecision(ctx, {
    source: 'system:work.offer',
    subject: person,
    class: 'deferrable',
    deadlineMonths: 1,
    promptId: 'prompt.work.offer',
    promptData: {
      title,
      employer: offer.employer,
      salary: offer.salary,
      hours: offer.hoursPerWeek,
      partTime: offer.hoursPerWeek < 30,
      insured: offer.insured,
      plan: offer.match > 0,
      pension: offer.pension,
      trainee: offer.level < 0,
      outside: offer.outside,
      current: current ? current.salary : 0,
      currentTitle: current ? jobTitle(content, current.occupation, current.level) : '',
    },
    options: [
      { id: 'accept', label: plainText(ctx, 'label.work.accept', person, { employer: offer.employer }) },
      { id: 'negotiate', label: plainText(ctx, 'label.work.negotiate', person, { employer: offer.employer }) },
      { id: 'decline', label: plainText(ctx, 'label.work.decline', person, { employer: offer.employer, outside: offer.outside }) },
    ],
    // An approach from another employer while in work is optional, and the governor may hold it back.
    optional: false,
    sourceClass: 'player',
  })
}

registerSystemDecision('work.offer', {
  resolve(ctx, _decision, subject, optionId, lapsed) {
    const { content, rng, state } = ctx
    const work = subject.work
    const offer = work?.offer
    if (!work || !offer) return
    const N = laborOf(content).pay.negotiate
    if (optionId === 'decline') {
      work.offer = null
      tell(ctx, subject, 'offer_declined', { employer: offer.employer, title: jobTitle(content, offer.occupation, offer.level), lapsed }, { source: 'player' })
      return
    }
    if (optionId === 'negotiate') {
      const u = rng.float('work.negotiate', subject.id, state.now)
      if (u < N.withdrawn) {
        work.offer = null
        tell(ctx, subject, 'negotiated', { which: 'withdrawn', employer: offer.employer, salary: offer.salary }, { significant: true, source: 'player' })
        return
      }
      if (u < N.withdrawn + N.succeeds) {
        offer.salary = Math.round(offer.salary * (1 + N.gain[0] + (N.gain[1] - N.gain[0]) * rng.float('work.negotiate.gain', subject.id, state.now)))
        tell(ctx, subject, 'negotiated', { which: 'raised', employer: offer.employer, salary: offer.salary }, { source: 'player' })
      } else {
        tell(ctx, subject, 'negotiated', { which: 'unchanged', employer: offer.employer, salary: offer.salary }, { source: 'player' })
      }
    }
    startJob(ctx, subject, offer, 'player')
  },
  weights(_state, _content, _decision, subject) {
    const work = subject.work
    const offer = work?.offer
    if (!work || !offer) return [1, 0, 0]
    // Asking for more comes easier to some than to others.
    const asks = 0.22 * dexp(-0.3 * (subject.traits.agreeableness ?? 0))
    if (!work.job) return [0.94 - asks, asks, 0.06]
    const better = offer.salary / offer.hoursPerWeek > (work.job.salary / work.job.hoursPerWeek) * 1.01 || work.job.warned
    return better ? [0.62, asks, 0.38 - asks] : [0.06, 0.04, 0.9]
  },
})

function searchMonth(ctx: Ctx, person: Person, work: Work): void {
  const { state, content, rng } = ctx
  const S = laborOf(content).search
  const level = searchLevel(content, person)
  const applications = S.applicationsPerMonth * level.applications
  if (applications <= 0) {
    if (work.status === 'unemployed') work.status = work.history.length > 0 ? 'home' : 'none'
    return
  }
  if (work.status !== 'unemployed') {
    work.status = 'unemployed'
    if (work.since === null) work.since = state.now
  }
  if (work.since === null) work.since = state.now
  if (work.offer || hasOpenDecision(state, 'system:work.offer', person)) return

  // What to look for: the line of work the person has set their mind on, or else whatever they
  // lean toward, reconsidered every few months without luck.
  const wanted = work.target ? content.occupations.get(work.target) : undefined
  const occ = wanted && qualifies(state, content, person, wanted) ? wanted : pickOccupation(ctx, person, 'search', work.since, Math.floor((state.now - work.since) / 4))
  if (!occ) return
  const chance = offerChance(ctx, person, occ)
  const anyOffer = 1 - dpow(1 - chance.probability, applications)
  if (rng.chance(anyOffer, 'work.search', person.id, state.now)) {
    presentOffer(ctx, person, work, makeOffer(ctx, person, occ, false))
    return
  }
  const months = state.now - work.since + 1
  if (person.id === state.playerId && months % 3 === 0) {
    const outcome: OutcomeRecord = {
      id: newId(state, 'out'),
      month: state.now,
      kind: 'job_search',
      subjectId: person.id,
      model: 'logit',
      base: chance.base,
      baseSource: content.bundle.country.labor.search.source,
      factors: chance.factors,
      probability: chance.probability,
      context: { title: occ.title, applications: Math.round(applications * 3) },
    }
    state.outcomes[outcome.id] = outcome
    tell(ctx, person, 'search_report', { months, applications: Math.round(applications * 3), title: occ.title }, { source: 'player', outcomeId: outcome.id, significant: months >= 6 })
  }
}

/** In-character defaults for whether to look for work, reset when a person's situation changes. */
function situationDefaults(ctx: Ctx, person: Person, work: Work): void {
  const { state, content, rng } = ctx
  const L = laborOf(content)
  const age = ageYears(person, state.now)
  const situation = person.education.status === 'k12' ? 'school' : studying(person) ? 'study' : 'free'
  const birthday = (state.now - person.born) % 12 === 0
  if (person.flags['work.situation'] === situation && !(situation === 'school' && birthday)) return
  const changed = person.flags['work.situation'] !== situation
  person.flags['work.situation'] = situation
  if (person.flags['work.home'] === true) return
  if (situation === 'school') {
    // Each year at school, some more teenagers take a job.
    const before = age > 16 ? interpolate(L.participation.teens, age - 1) : 0
    const share = (interpolate(L.participation.teens, age) - before) / Math.max(0.01, 1 - before)
    if (person.policies.search === 'none' && rng.chance(share, 'work.teen', person.id, age)) person.policies.search = 'open'
    else if (changed) person.policies.search = 'none'
    return
  }
  if (situation === 'study') person.policies.search = work.job || rng.chance(L.participation.students, 'work.student', person.id, state.now) ? 'open' : 'none'
  else person.policies.search = work.job ? 'open' : 'active'
  // Hours follow the situation: a student cannot hold a full week's work, and a school job grows when school ends.
  const job = work.job
  if (!job) return
  const occ = occupationOf(content, job.occupation)
  const hours = situation === 'study' ? Math.min(job.hoursPerWeek, 20) : person.flags['work.partTime'] === true ? job.hoursPerWeek : Math.max(job.hoursPerWeek, occ.hours)
  if (hours !== job.hoursPerWeek) {
    const hourly = (h: number): number => (h < 30 ? L.pay.partTimeHourly : 1)
    job.salary = Math.round((job.salary * hours * hourly(hours)) / (job.hoursPerWeek * hourly(job.hoursPerWeek)))
    job.hoursPerWeek = hours
    job.insured = job.insured && hours >= 30
  }
}

function orgsMonth(ctx: Ctx): void {
  const { state, content, rng } = ctx
  const T = laborOf(content).employers.trouble
  const staff = new Map<string, Person[]>()
  for (const person of livingPeople(state)) {
    const id = person.work?.job?.orgId
    if (id) staff.set(id, [...(staff.get(id) ?? []), person])
  }
  for (const id of Object.keys(state.orgs).sort()) {
    const org = state.orgs[id]!
    const workers = staff.get(id)
    if (!workers) {
      delete state.orgs[id]
      continue
    }
    const occ = occupationOf(content, workers[0]!.work!.job!.occupation)
    const sector = content.bundle.country.economy.sectors.find((s) => s.id === org.sector)
    if (org.health === 'sound') {
      const weather = dexp(T.perPointOfUnemployment * slack(content, state.world, (occ.cyclical + (sector?.cyclical ?? 1)) / 2)) / Math.max(0.3, state.world.sectors[org.sector]?.index ?? 1)
      if (rng.chance(Math.min(0.5, org.risk * weather), 'org.trouble', id, state.now)) {
        org.health = 'quiet'
        org.since = state.now
        org.until = state.now + rng.range(T.quietMonths[0], T.quietMonths[1], 'org.quiet', id, state.now)
      }
      continue
    }
    if (org.health === 'quiet') {
      // The signs (design §9.2): seen by people who have been there long enough to know what is normal.
      for (const worker of workers) {
        if (!rng.chance(T.signalPerMonth, 'org.signal', id, worker.id, state.now)) continue
        const which = rng.pick(['hiring_freeze', 'departures', 'late_payments', 'cutbacks'] as const, 'org.signalKind', id, worker.id, state.now)
        const noticed = state.now - worker.work!.job!.started >= 6
        tell(ctx, worker, 'work_signal', { which, employer: org.name, manager: worker.work!.job!.manager }, { hidden: !noticed })
      }
      const turn = rng.float('org.turn', id, state.now)
      const ends = state.now >= org.until
      if (turn < T.layoffsPerMonth || (ends && turn < 0.5)) {
        org.health = 'layoffs'
        org.since = state.now
        org.until = state.now + rng.range(T.layoffMonths[0], T.layoffMonths[1], 'org.layoffs', id, state.now)
      } else if (turn > 1 - T.recoverPerMonth || ends) {
        org.health = 'sound'
        org.since = state.now
      }
      continue
    }
    // Layoffs are under way; individual jobs are lost in each worker's own month. When they end,
    // the employer has either steadied or closed.
    if (state.now >= org.until) {
      if (rng.chance(T.closes, 'org.closes', id, state.now)) {
        for (const worker of workers) if (worker.work?.job?.orgId === id) loseJob(ctx, worker, 'closed')
        delete state.orgs[id]
      } else {
        org.health = 'sound'
        org.since = state.now
      }
    }
  }
}

/** One month of the labor market for everyone (design §5.2, phase 5). */
export function workMonth(ctx: Ctx): void {
  const { state, content } = ctx
  const L = laborOf(content)
  orgsMonth(ctx)
  for (const person of livingPeople(state)) {
    const age = ageYears(person, state.now)
    if (age < 16) continue
    const work = ensureWork(ctx, person)
    if (monthOf(state.now) === 0) {
      // The year's earnings go on the record Social Security keeps, in start-year dollars.
      if (work.yearWages > 0) work.earnings.push(Math.round(work.yearWages / state.world.priceLevel))
      work.yearWages = 0
    }
    if (!person.died && !work.benefit && age >= content.bundle.country.tax.socialSecurity.earliestAge) benefitMonth(ctx, person, work, age)
    if (work.status === 'retired') continue
    if (age >= L.participation.stopBy) {
      retire(ctx, person)
      continue
    }
    situationDefaults(ctx, person, work)
    fadeSkills(content, work)
    // Other people step out of work and back in of their own accord; the player decides.
    const O = L.participation.stepOut
    if (person.id !== state.playerId && age >= O.fromAge && age < O.untilAge && !studying(person)) {
      const odds = stepOdds(state, content, person)
      if (work.status === 'home' && person.flags['work.home'] === true) {
        if (ctx.rng.chance(odds.back, 'work.stepBack', person.id, state.now)) {
          person.flags['work.home'] = false
          person.policies.search = 'active'
        }
      } else if ((work.status === 'employed' || work.status === 'unemployed') && ctx.rng.chance(odds.out, 'work.stepOut', person.id, state.now)) {
        stepOut(ctx, person, work)
        continue
      }
    }
    if (work.job) employedMonth(ctx, person, work, work.job)
    else searchMonth(ctx, person, work)

  }
}

/**
 * The retirement benefit (design §7.13). The player is asked once a year from the earliest age;
 * other people claim when they stop working at that age or later, or at full retirement age if
 * still working; everyone has claimed by the latest age.
 */
function benefitMonth(ctx: Ctx, person: Person, work: Work, age: number): void {
  const { state, content } = ctx
  const S = content.bundle.country.tax.socialSecurity
  if (person.id !== state.playerId) {
    if (age >= S.latestAge || (age >= S.earliestAge && !work.job) || (age >= S.fullAge && work.job)) claimBenefit(ctx, person)
    return
  }
  if (age >= S.latestAge) claimBenefit(ctx, person)
  else if (person.id === state.playerId && age >= S.earliestAge && (state.now - person.born) % 12 === 0 && !hasOpenDecision(state, 'system:work.claim', person)) {
    const now = retirementBenefit(ctx, person)
    const full = Math.round(primaryInsuranceAmount(content.bundle.country.tax, work.earnings) * claimingFactor(content.bundle.country.tax, Math.max(S.fullAge * 12, state.now - person.born + 12)))
    openDecision(ctx, {
      source: 'system:work.claim',
      subject: person,
      class: 'deferrable',
      deadlineMonths: 2,
      promptId: 'prompt.work.claim',
      promptData: { monthly: Math.round(now * state.world.priceLevel), later: Math.round(full * state.world.priceLevel), age, fullAge: S.fullAge, working: work.job !== null },
      options: [
        { id: 'claim', label: plainText(ctx, 'label.work.claim', person) },
        { id: 'wait', label: plainText(ctx, 'label.work.wait', person) },
      ],
      optional: false,
      sourceClass: 'structural',
    })
  }
}

registerSystemDecision('work.claim', {
  resolve(ctx, _decision, subject, optionId) {
    if (optionId === 'claim') claimBenefit(ctx, subject)
  },
  weights(state, content, _decision, subject) {
    // Most people claim as soon as they stop working, and few wait past the full age.
    const S = content.bundle.country.tax.socialSecurity
    const age = ageYears(subject, state.now)
    const claim = subject.work?.job ? (age >= S.fullAge ? 0.6 : 0.12) : 0.8
    return [claim, 1 - claim]
  },
})

// ---------------------------------------------------------------------------------------------
// What the player can do
// ---------------------------------------------------------------------------------------------

registerAction('work.look_for', {
  available(state, content, person) {
    if (ageYears(person, state.now) < 16 || person.work?.status === 'retired') return null
    const options = occupationWeights(state, content, person)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 14)
      .sort((a, b) => a.occ.title.localeCompare(b.occ.title))
    if (options.length === 0) return null
    const ctx = reader(state, content)
    const current = person.work?.target ?? null
    return {
      label: plainText(ctx, 'label.act.look_for', person, { current: current ? (content.occupations.get(current)?.title ?? '') : '' }),
      section: 'work',
      choices: [...options.filter((o) => o.occ.id !== current).map((o) => ({ id: o.occ.id, label: jobTitle(content, o.occ.id, levelFor(content, person, o.occ)) })), ...(current ? [{ id: 'anything', label: plainText(ctx, 'label.act.look_for_anything', person) }] : [])],
    }
  },
  perform(ctx, person, choice) {
    const work = ensureWork(ctx, person)
    const occ = choice && choice !== 'anything' ? ctx.content.occupations.get(choice) : undefined
    work.target = occ ? occ.id : null
    if (person.policies.search === 'none') person.policies.search = work.job ? 'open' : 'active'
    tell(ctx, person, 'looking_for', { title: occ?.title ?? '', any: !occ, working: work.job !== null }, { source: 'player' })
  },
})

registerAction('work.quit', {
  available(state, content, person) {
    const job = person.work?.job
    if (!job) return null
    return { label: plainText(reader(state, content), 'label.act.quit', person, { employer: job.employer }), section: 'work', costs: ['no unemployment benefit if you leave by choice'] }
  },
  perform(ctx, person) {
    quit(ctx, person)
  },
})

registerAction('work.retire', {
  available(state, content, person) {
    const work = person.work
    if (!work || work.status === 'retired' || ageYears(person, state.now) < 50) return null
    return { label: plainText(reader(state, content), 'label.act.retire', person), section: 'work' }
  },
  perform(ctx, person) {
    retire(ctx, person)
  },
})

/** Yearly chance that this person retires of their own accord, for AI players (who act once a year). */
export function workChances(state: GameState, content: Prepared, person: Person): { retire: number; stepOut: number; stepBack: number } {
  const work = person.work
  if (!work || work.status === 'retired') return { retire: 0, stepOut: 0, stepBack: 0 }
  const P = laborOf(content).participation
  const age = ageYears(person, state.now)
  const inRange = age >= P.stepOut.fromAge && age < P.stepOut.untilAge && !studying(person)
  return {
    retire: retireChance(content, age),
    stepOut: inRange && (work.status === 'employed' || work.status === 'unemployed') ? 1 - dpow(1 - stepOdds(state, content, person).out, 12) : 0,
    stepBack: inRange && work.status === 'home' ? 1 - dpow(1 - stepOdds(state, content, person).back, 12) : 0,
  }
}

// ---------------------------------------------------------------------------------------------
// Adults who enter the simulation already grown
// ---------------------------------------------------------------------------------------------

/** Gives a parent the working life they would plausibly have by now. Called once, when the family is created. */
export function settleFounder(ctx: Ctx, person: Person, role: 'mother' | 'father'): void {
  const { state, content, rng } = ctx
  const L = laborOf(content)
  const work = ensureWork(ctx, person)
  const age = ageYears(person, state.now)
  person.flags['work.situation'] = 'free'
  person.policies.search = 'open'
  const participates = rng.chance(role === 'father' ? L.participation.fathers : L.participation.mothers, 'work.participates', person.id)
  if (role === 'mother' && participates && rng.chance(L.participation.mothersPartTime, 'work.partTime', person.id)) person.flags['work.partTime'] = true

  // The line of work: anything their schooling and years allow. Whatever license it needs, they hold.
  const startAge = [17, 18, 20, 20, 22, 26][educationRank(person.education.level)] ?? 18
  const years = Math.max(0, age - startAge) * (0.55 + 0.4 * rng.float('work.founder.years', person.id))
  const rank = educationRank(person.education.level)
  const options = L.occupations.filter((o) => educationRank(o.education) <= rank && o.experienceYears <= years * 0.8)
  const weights = options.map((o) => o.employment * dpow(2 * (person.sex === 'female' ? o.female : 1 - o.female) + 0.02, L.search.sexTyping) * dpow(0.3, rank - educationRank(o.education)) * (o.experienceYears > 0 ? 0.5 : 1) * dexp(0.5 * fitFor(person, o)))
  const occ = options[Math.max(0, rng.weighted(weights, 'work.founder.occupation', person.id))] ?? L.occupations[0]!
  if (occ.credential) person.credentials.push(occ.credential)
  const months = Math.round(years * 12 * (0.4 + 0.6 * rng.float('work.founder.share', person.id)))
  work.months[occ.id] = months
  let skill = 0
  for (let m = 0; m < months; m += 6) skill += 6 * L.skill.perMonth * dexp(L.skill.aptitude * fitFor(person, occ)) * dpow(Math.max(0, 1 - skill), L.skill.power)
  work.skills[occ.id] = clamp(skill, 0, 1)
  if (years * 12 > months) work.months[options[0]!.id === occ.id ? (options[1]?.id ?? occ.id) : options[0]!.id] = Math.round(years * 12 - months)

  const offer = makeOffer(ctx, person, occ, false)
  const typical = offer.salary / state.world.priceLevel
  for (let y = 0; y < Math.round(years); y++) work.earnings.push(Math.round(typical * (participates ? 0.9 : 0.4)))
  if (!participates) {
    if (role === 'mother') {
      work.status = 'home'
      person.policies.search = 'none'
      person.flags['work.home'] = true
    } else {
      work.status = 'unemployed'
      work.since = state.now - rng.int(9, 'work.founder.out', person.id)
      person.policies.search = 'active'
      work.history.push({ occupation: occ.id, employer: offer.employer, from: work.since - 24, to: work.since, why: 'layoffs' })
    }
    return
  }
  const org: Org = { id: newId(state, 'org'), name: offer.employer, sector: occ.sector, pay: offer.orgPay, health: 'sound', since: state.now, until: state.now, risk: L.employers.trouble.perMonth[person.education.level] }
  state.orgs[org.id] = org
  const started = state.now - 1 - rng.int(Math.max(1, Math.min(months, 96)), 'work.founder.tenure', person.id)
  work.job = {
    occupation: occ.id,
    level: offer.level,
    orgId: org.id,
    employer: offer.employer,
    manager: rng.pick(L.employers.names.managers, 'work.manager', person.id, state.now),
    started,
    hoursPerWeek: offer.hoursPerWeek,
    salary: offer.salary,
    insured: offer.insured,
    match: offer.match,
    pension: offer.pension,
    payIndex: state.world.wageIndex,
    performance: clamp(0.5 + 0.08 * (person.traits.conscientiousness ?? 0) + 0.06 * fitFor(person, occ), 0.2, 0.9),
    warned: false,
  }
  work.status = 'employed'
  if (occ.pension) work.pensionYears = (state.now - started) / 12
  ensureMoney(person).credit.opened = state.now - Math.round(Math.max(1, age - 19) * 12)
}

/** Yearly earnings before tax that a person brings in right now, in the dollars of the day. */
export function currentIncome(ctx: Pick<Ctx, 'state' | 'content'>, person: Person): number {
  const work = person.work
  if (!work || person.died) return 0
  const px = ctx.state.world.priceLevel
  let income = work.job ? work.job.salary : 0
  if (!work.job && work.insurance && ctx.state.now <= work.insurance.until) income += work.insurance.weekly * 52
  if (work.benefit) income += work.benefit.monthly * 12 * px
  if (work.status === 'retired' && ageYears(person, ctx.state.now) >= ctx.content.bundle.country.money.pension.fromAge) income += work.pension * 12 * px
  return income
}
