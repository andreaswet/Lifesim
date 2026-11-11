/**
 * Headless batch simulation and its statistics (design §13). Kept free of file and console access
 * so tests can call it; `batch.ts` is the command-line wrapper.
 */

import { checkInvariants, createLife, currentIncome, netWorth, povertyLine, type EngineEnv, type GameState, type Prepared } from '../engine'
import { monthlyFromAnnual } from '../engine/content/prepare'
import { inverseNormalCdf } from '../engine/core/dmath'
import { EDU_LEVELS } from '../engine/content/country-schema'
import { player, type Person } from '../engine/state'
import { playYear, type Strategy } from './players'

/** What a batch records about one life's family and schooling (design §13.2). */
export interface SchoolingResult {
  /** At birth. */
  couple: 'married' | 'cohabiting' | 'apart'
  motherEducation: string
  parentEducationRank: number
  incomeAtBirth: number
  olderSiblings: number
  /** Home support for learning at birth, as computed by the engine (should be near N(0, 1)). */
  /** Birthdays under 18 reached, and how many of them with both parents at home. */
  childYears: number
  twoParentYears: number
  siblingsEver: number
  /** Achievement at the end of each grade reached, in grade equivalents. */
  literacy: Array<number | null>
  math: Array<number | null>
  standingGrade8: number | null
  hsGpa: number | null
  /** Age at which the diploma or equivalency was held, if ever. */
  diplomaAge: number | null
  graduatedOnTime: boolean
  testTotal: number | null
  /** Tier entered in the autumn after graduating, if any. */
  enrolledRightAway: string | null
  everEnrolled: string | null
  /** Highest level at 27, if alive then. */
  levelAt27: string | null
  loansAtBachelor: number | null
  /** For those who entered a four-year college: years from entry to the degree, if earned. */
  yearsToBachelor: number | null
  enteredFourYear: boolean
  enteredTwoYear: boolean
  associateEver: boolean
  transferred: boolean
}

/** One birthday of a life, as a survey would record it (design §13.2). Money is in start-year dollars. */
export interface YearRecord {
  age: number
  education: string
  /** emp, unemp (looking), nilf (not looking), retired, school (at school or full-time college, not working). */
  status: 'emp' | 'unemp' | 'nilf' | 'retired' | 'school'
  fullTime: boolean
  /** Yearly pay of the job held, if any. */
  pay: number
  occupation: string | null
  /** Months in the current job. */
  tenure: number
  /** The person's household: its income, size, and whether this person is in the unit that pays for it. */
  hhIncome: number
  /** What the person and a partner they live with bring in. */
  income: number
  hhSize: number
  head: boolean
  /** Net worth of the person's unit (themselves and a partner they live with). */
  worth: number
  housing: 'own' | 'rent' | 'parents' | 'guest' | 'other'
  rent: number
  cover: string
  credit: number | null
  poor: boolean
}

export interface LifeResult {
  seed: string
  strategy: Strategy
  sex: 'male' | 'female'
  /** Age at death in years, to the middle of the month of death. */
  ageAtDeath: number
  simulatedYears: number
  fluCount: number
  decisionsOpened: Record<string, number>
  yearsInStage: Record<string, number>
  significantBySource: Record<string, number>
  /** Cardio stock at the 60th birthday, if reached. */
  cardioAt60: number | null
  activityAt60: string | null
  variantCounts: Record<string, number>
  feedLines: number
  invariantProblems: string[]
  schooling: SchoolingResult
  ethnicity: string
  years: YearRecord[]
  /** Jobs started between 18 and 56. */
  jobsBy56: number | null
  /** Jobs lost to an employer's trouble, and how many of those the character saw signs of first (design §9.5). */
  layoffs: number
  warnedLayoffs: number
  retiredAt: number | null
  recessions: number
}

export function runLife(seed: string, strategy: Strategy, env: EngineEnv): LifeResult {
  const { content } = env
  // Batch lives are never protected in early childhood: the statistics must be honest.
  let state: GameState = createLife({ seed, start: { protectPlayerUntilAge: 0 } }, env)
  const self = (): ReturnType<typeof player> => player(state)
  const problems: string[] = []

  const me = self()
  const mother = me.motherId ? state.people[me.motherId] : undefined
  const father = me.fatherId ? state.people[me.fatherId] : undefined
  const home0 = me.householdId ? state.households[me.householdId] : undefined
  const rank = (p: Person | undefined): number => (p ? EDU_LEVELS.indexOf(p.education.level) : 0)
  const schooling: SchoolingResult = {
    couple: mother && father && mother.partner?.id === father.id ? mother.partner.status : 'apart',
    motherEducation: mother?.education.level ?? '',
    parentEducationRank: (rank(mother) + rank(father)) / 2,
    incomeAtBirth: home0?.income ?? 0,
    olderSiblings: Object.values(state.people).filter((p) => p.motherId === me.motherId && p.id !== me.id).length,
    childYears: 0,
    twoParentYears: 0,
    siblingsEver: 0,
    literacy: new Array<number | null>(13).fill(null),
    math: new Array<number | null>(13).fill(null),
    standingGrade8: null,
    hsGpa: null,
    diplomaAge: null,
    graduatedOnTime: false,
    testTotal: null,
    enrolledRightAway: null,
    everEnrolled: null,
    levelAt27: null,
    loansAtBachelor: null,
    yearsToBachelor: null,
    enteredFourYear: false,
    enteredTwoYear: false,
    associateEver: false,
    transferred: false,
  }
  let firstCollegeStart: number | null = null
  const survey: YearRecord[] = []
  let retiredAt: number | null = null
  let jobsBy56: number | null = null
  const record = (): void => {
    const p = self()
    if (p.died) return
    const age = Math.floor((state.now - p.born) / 12)
    const px = state.world.priceLevel
    const home = p.householdId ? state.households[p.householdId] : undefined
    const work = p.work
    const job = work?.job
    const edu = p.education
    const inSchool = edu.status === 'k12' || (edu.status === 'college' && !edu.college?.partTime)
    const status: YearRecord['status'] = job ? 'emp' : work?.status === 'retired' ? 'retired' : inSchool ? 'school' : work?.status === 'unemployed' ? 'unemp' : 'nilf'
    const partner = p.partner ? state.people[p.partner.id] : undefined
    const together = partner && !partner.died && partner.householdId === p.householdId
    const unit = [p.id, ...(together ? [partner.id] : [])]
    const payer = home?.housing.payer ?? null
    const head = payer !== null && unit.includes(payer)
    const parentsHome = !head && [p.motherId, p.fatherId].some((id) => id !== null && id === payer)
    const hhIncome = (home?.income ?? 0) / px
    const size = home?.members.length ?? 1
    if (status === 'retired' && retiredAt === null) retiredAt = age
    if (age === 56 && jobsBy56 === null && work) jobsBy56 = work.history.filter((h) => (h.from - p.born) / 12 >= 18).length + (job && (job.started - p.born) / 12 >= 18 ? 1 : 0)
    survey.push({
      age,
      education: edu.level,
      status,
      fullTime: !!job && job.hoursPerWeek >= 35,
      pay: job ? job.salary / px : 0,
      occupation: job?.occupation ?? null,
      tenure: job ? state.now - job.started : 0,
      hhIncome,
      income: unit.reduce((a, id) => a + currentIncome({ state, content }, state.people[id]!), 0) / px,
      hhSize: size,
      head,
      worth: unit.reduce((a, id) => a + netWorth(state, id), 0) / px,
      housing: head ? (home?.housing.tenure === 'own' ? 'own' : home?.housing.tenure === 'rent' ? 'rent' : 'guest') : parentsHome ? 'parents' : 'other',
      // A shared rental is one household; its rent is the whole, as the Census counts it.
      rent: head && home?.housing.tenure === 'rent' ? home.housing.rent / px / (home.housing.shared ? content.bundle.country.money.housing.sharedRent : 1) : 0,
      cover: p.money?.cover ?? '',
      credit: null,
      poor: hhIncome < povertyLine({ state, content }, size),
    })
  }
  const observe = (): void => {
    const p = self()
    const age = Math.floor((state.now - p.born) / 12)
    const edu = p.education
    if (age < 18 && !p.died) {
      schooling.childYears++
      const parents = [p.motherId, p.fatherId].filter((id) => id && !state.people[id]?.died && state.people[id]?.householdId === p.householdId).length
      if (parents === 2) schooling.twoParentYears++
    }
    if (edu.lastReport) {
      const g = edu.lastReport.grade
      if (schooling.literacy[g] === null) {
        schooling.literacy[g] = edu.lastReport.skills.literacy ?? null
        schooling.math[g] = edu.lastReport.skills.math ?? null
        if (g === 8) schooling.standingGrade8 = edu.standing
      }
    }
    if (edu.hs.years > 0) schooling.hsGpa = edu.hs.gpaSum / edu.hs.years
    if (edu.test) schooling.testTotal = edu.test.verbal + edu.test.math
    if (schooling.diplomaAge === null && edu.level !== 'less_than_hs') {
      schooling.diplomaAge = age
      schooling.graduatedOnTime = age <= 19 && edu.status !== 'left_k12'
    }
    if (edu.college) {
      const tier = content.bundle.country.education.tiers.find((t) => t.id === edu.college!.tier)
      if (schooling.everEnrolled === null) {
        schooling.everEnrolled = edu.college.tier
        firstCollegeStart = edu.college.started

      } else if (schooling.everEnrolled === 'community' && tier && !tier.open) schooling.transferred = true
      if (tier?.open) schooling.enteredTwoYear = true
      else if (schooling.everEnrolled !== 'community') schooling.enteredFourYear = true
    }
    if (edu.level === 'associate' || (edu.level === 'bachelor' && schooling.everEnrolled === 'community')) schooling.associateEver = schooling.associateEver || edu.level === 'associate'
    if (edu.level === 'bachelor' && schooling.loansAtBachelor === null) {
      schooling.loansAtBachelor = edu.loans
      if (firstCollegeStart !== null) schooling.yearsToBachelor = (state.now - firstCollegeStart) / 12
    }
    if (age === 27) schooling.levelAt27 = edu.level
  }
  const yearsInStage: Record<string, number> = {}
  let cardioAt60: number | null = null
  let activityAt60: string | null = null
  let years = 0

  // A year can take several calls: the advance stops whenever a decision opens. Each age is
  // counted and surveyed once, on the birthday itself, so moments of decision are not oversampled.
  let lastAge = -1
  let calls = 0
  while (state.phase === 'alive') {
    const age = Math.floor((state.now - self().born) / 12)
    if (age !== lastAge && (state.now - self().born) % 12 === 0) {
      lastAge = age
      const stage = content.stageFor(age)
      yearsInStage[stage] = (yearsInStage[stage] ?? 0) + 1
      if (age === 60 && cardioAt60 === null) {
        cardioAt60 = self().body.cardio
        activityAt60 = self().policies.activity
      }
      record()
      years++
      if (years % 10 === 0) problems.push(...checkInvariants(state, content))
    }
    state = playYear(state, strategy, { ...env, mutate: true })
    observe()
    if (state.phase === 'ended') problems.push(...checkInvariants(state, content))
    if (++calls > 2000) {
      problems.push('life did not end')
      break
    }
  }

  const person = self()
  const died = person.died?.at ?? state.now
  let layoffs = 0
  let warnedLayoffs = 0
  for (const entry of state.log) {
    if (entry.fact.kind !== 'job_lost' || (entry.fact.data.which !== 'layoffs' && entry.fact.data.which !== 'closed')) continue
    layoffs++
    const employer = entry.fact.data.employer
    if (state.log.some((e) => e.fact.kind === 'work_signal' && !e.hidden && e.fact.data.employer === employer && e.month <= entry.month && e.month >= entry.month - 18)) warnedLayoffs++
  }
  const decisionsOpened: Record<string, number> = {}
  const significantBySource: Record<string, number> = {}
  let fluCount = 0
  let feedLines = 0
  // "Right away" means the autumn after graduating, as the Census survey behind the target counts it.
  const graduated = state.log.find((e) => e.fact.kind === 'hs_graduated')
  const started = state.log.find((e) => e.fact.kind === 'college_started')
  if (graduated && started && started.month - graduated.month <= 4) schooling.enrolledRightAway = String(started.fact.data.which)
  schooling.graduatedOnTime = graduated !== undefined
  for (const entry of state.log) {
    if (entry.fact.kind === 'illness_started') fluCount++
    if (entry.fact.kind === 'decision_opened') {
      const stage = content.stageFor(entry.age)
      decisionsOpened[stage] = (decisionsOpened[stage] ?? 0) + 1
    }
    if (entry.fact.significant && !entry.hidden && entry.sourceClass !== 'system') {
      significantBySource[entry.sourceClass] = (significantBySource[entry.sourceClass] ?? 0) + 1
    }
    if (entry.text && !entry.hidden) feedLines++
  }

  return {
    seed,
    strategy,
    sex: person.sex,
    ageAtDeath: (died - person.born + 0.5) / 12,
    simulatedYears: (died - person.born) / 12,
    fluCount,
    decisionsOpened,
    yearsInStage,
    significantBySource,
    cardioAt60,
    activityAt60,
    variantCounts: { ...state.narration.counts },
    feedLines,
    invariantProblems: problems,
    ethnicity: person.ethnicity,
    years: survey,
    jobsBy56,
    layoffs,
    warnedLayoffs,
    retiredAt,
    recessions: state.world.recessions,
    schooling: { ...schooling, siblingsEver: Object.values(state.people).filter((p) => p.id !== person.id && p.motherId !== null && p.motherId === person.motherId).length },
  }
}

export interface TableTargets {
  lifeExpectancy: number
  /** Probability of surviving from birth to each age. */
  survival: Record<number, number>
}

export const SURVIVAL_AGES = [1, 20, 40, 65, 85, 100]

/** What the life table itself implies, computed with the same monthly compounding the engine uses. */
export function tableTargets(content: Prepared, sex: 'male' | 'female'): TableTargets {
  const maxAge = content.bundle.country.lifeTable.maxAge
  let alive = 1
  let expectancy = 0
  const survival: Record<number, number> = {}
  for (let month = 0; month <= maxAge * 12; month++) {
    const age = Math.floor(month / 12)
    if (month % 12 === 0 && SURVIVAL_AGES.includes(age)) survival[age] = alive
    const q = monthlyFromAnnual(content.annualMortality(sex, age))
    expectancy += (alive * q * (month + 0.5)) / 12
    alive *= 1 - q
  }
  return { lifeExpectancy: expectancy, survival }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

function standardError(xs: number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  const variance = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)
  return Math.sqrt(variance / xs.length)
}

export interface BatchSummary {
  lives: number
  bySex: Record<'male' | 'female', { lives: number; lifeExpectancy: number; standardError: number; target: number; survival: Record<number, { simulated: number; target: number }> }>
  maleShare: number
  infantMortalityPer1000: { simulated: number; target: number }
  fluPerPersonYear: number
  decisionsPerYearByStage: Record<string, number>
  significantSourceShares: Record<string, number>
  cardioAt60ByActivity: Record<string, { lives: number; mean: number }>
  text: {
    feedLinesPerLife: number
    distinctVariantsUsed: number
    /** Variants with the highest average uses per life. */
    mostUsed: Array<{ variant: string; perLife: number; maxInOneLife: number }>
    /** Share of lives in which some variant appeared more than twice (design target: none). */
    livesWithAVariantOverTwice: number
  }
  invariantProblems: string[]
  msPerSimulatedYear: number
  schooling: SchoolingSummary
  work: WorkSummary
}

export interface WorkSummary {
  /** Unemployed as a share of the labor force, ages 16 and over; and among those 25 and over, by schooling. */
  unemployment: number
  unemploymentByEducation: Record<string, number>
  /** Employed share of people 25–54. */
  primeAgeEmployment: number
  /** Median weekly pay of full-time workers 25 and over, start-year dollars; by schooling; women's as a share of men's. */
  medianWeekly: number
  medianWeeklyByEducation: Record<string, number>
  womenToMen: number
  bachelorPremium: number
  medianHouseholdIncome: number
  poverty: number
  medianWorth: number
  medianWorthByAge: Record<string, number>
  owning: number
  owningUnder35: number
  withParents18to24: number
  withParents25to34: number
  medianRent: number
  uninsured: number
  medianTenureYears: number
  jobsBy56: number
  medianRetirementAge: number
  /** Rank-rank slope of child household income at 30–34 on parents' at birth (Chetty et al. 2014). */
  rankSlope: number
  bottomToTop: number
  yearsPerRecession: number
  /** Median household worth at 45–54, by group (design decision Q1). */
  worthByGroup: Record<string, number>
  /** Share of jobs lost to an employer's trouble that were preceded by a sign the character noticed. */
  layoffsWarned: number
}

export interface SchoolingSummary {
  birth: { married: number; cohabiting: number; apart: number; medianIncome: number; meanSiblings: number }
  childrenWithTwoParents: number
  /** Mean and spread of achievement at the end of each grade: the norms. */
  norms: Record<'literacy' | 'math', { mean: number[]; sd: number[] }>
  meanHsGpa: number
  graduatedOnTime: number
  completedHighSchoolAt27: number
  testTakers: number
  meanTestTotal: number
  sdTestTotal: number
  enrolledRightAway: { any: number; twoYear: number; fourYear: number }
  byTier: Record<string, number>
  associateOrHigherAt27: number
  bachelorAt27: number
  bachelorAt27BySex: { male: number; female: number }
  /** Bachelor's by 27, by quarter of family income at birth, poorest first. */
  bachelorByIncomeQuarter: number[]
  enrolledByIncomeQuarter: number[]
  /**
   * Gap in eighth-grade achievement between children at the 90th and at the 10th percentile of
   * family income, in SD: the correlation with income rank times the 2.56 SD between those points.
   */
  achievementGap9010: number
  everEnrolledBy27: number
  parentChildEducationCorrelation: number
  sixYearCompletionFourYear: number
  twoYearEntrants: { associate: number; transferred: number; bachelor: number }
  borrowedAmongBachelors: number
  meanDebtAmongBorrowers: number
}

function correlation(xs: number[], ys: number[]): number {
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my)
    sxx += (xs[i]! - mx) ** 2
    syy += (ys[i]! - my) ** 2
  }
  return sxy / Math.sqrt(sxx * syy)
}

function sd(xs: number[]): number {
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, xs.length - 1))
}

function summarizeSchooling(results: LifeResult[]): SchoolingSummary {
  const all = results.map((r) => r.schooling)
  const share = (xs: SchoolingResult[], test: (s: SchoolingResult) => boolean): number => (xs.length ? xs.filter(test).length / xs.length : NaN)
  const incomes = all.map((s) => s.incomeAtBirth).sort((a, b) => a - b)
  const quantile = (q: number): number => incomes[Math.min(incomes.length - 1, Math.floor(q * incomes.length))] ?? 0
  const cuts = [quantile(0.25), quantile(0.5), quantile(0.75)]
  const quarter = (s: SchoolingResult): number => (s.incomeAtBirth <= cuts[0]! ? 0 : s.incomeAtBirth <= cuts[1]! ? 1 : s.incomeAtBirth <= cuts[2]! ? 2 : 3)

  const at27 = all.filter((s) => s.levelAt27 !== null)
  const rankOf = (level: string | null): number => EDU_LEVELS.indexOf(level as (typeof EDU_LEVELS)[number])
  const graduates = all.filter((s) => s.graduatedOnTime)
  const reached18 = results.filter((r) => r.simulatedYears >= 19).map((r) => r.schooling)
  const takers = all.filter((s) => s.testTotal !== null)
  const bachelors = at27.filter((s) => rankOf(s.levelAt27) >= rankOf('bachelor') && s.loansAtBachelor !== null)
  const borrowers = bachelors.filter((s) => (s.loansAtBachelor ?? 0) > 0)
  // Those who started at a four-year college straight from school, as completion statistics do.
  const fourYear = at27.filter((s) => s.enrolledRightAway !== null && s.enrolledRightAway !== 'community')
  const twoYear = at27.filter((s) => s.everEnrolled === 'community')
  const grade8 = all.filter((s) => s.standingGrade8 !== null)
  // Income as a normal score of its rank, so the correlation is not driven by a few large incomes.
  const incomeRankZ = (income: number): number => {
    let lo = 0
    let hi = incomes.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (incomes[mid]! < income) lo = mid + 1
      else hi = mid
    }
    return inverseNormalCdf((lo + 0.5) / (incomes.length + 1))
  }

  const norms = { literacy: { mean: [] as number[], sd: [] as number[] }, math: { mean: [] as number[], sd: [] as number[] } }
  for (const subject of ['literacy', 'math'] as const) {
    for (let g = 0; g <= 12; g++) {
      const values = all.map((s) => s[subject][g]).filter((v): v is number => v !== null && v !== undefined)
      norms[subject].mean.push(Math.round(mean(values) * 1000) / 1000)
      norms[subject].sd.push(Math.round(sd(values) * 1000) / 1000)
    }
  }
  const tiers: Record<string, number> = {}
  for (const s of graduates) if (s.enrolledRightAway) tiers[s.enrolledRightAway] = (tiers[s.enrolledRightAway] ?? 0) + 1 / graduates.length

  return {
    birth: {
      married: share(all, (s) => s.couple === 'married'),
      cohabiting: share(all, (s) => s.couple === 'cohabiting'),
      apart: share(all, (s) => s.couple === 'apart'),
      medianIncome: quantile(0.5),
      meanSiblings: mean(at27.map((s) => s.siblingsEver)),
    },
    childrenWithTwoParents: all.reduce((a, s) => a + s.twoParentYears, 0) / Math.max(1, all.reduce((a, s) => a + s.childYears, 0)),
    norms,
    meanHsGpa: mean(all.filter((s) => s.hsGpa !== null).map((s) => s.hsGpa!)),
    graduatedOnTime: share(reached18, (s) => s.graduatedOnTime),
    completedHighSchoolAt27: share(at27, (s) => s.levelAt27 !== 'less_than_hs'),
    testTakers: share(reached18, (s) => s.testTotal !== null),
    meanTestTotal: mean(takers.map((s) => s.testTotal!)),
    sdTestTotal: sd(takers.map((s) => s.testTotal!)),
    enrolledRightAway: {
      any: share(graduates, (s) => s.enrolledRightAway !== null),
      twoYear: share(graduates, (s) => s.enrolledRightAway === 'community'),
      fourYear: share(graduates, (s) => s.enrolledRightAway !== null && s.enrolledRightAway !== 'community'),
    },
    byTier: tiers,
    associateOrHigherAt27: share(at27, (s) => rankOf(s.levelAt27) >= rankOf('associate')),
    bachelorAt27: share(at27, (s) => rankOf(s.levelAt27) >= rankOf('bachelor')),
    bachelorAt27BySex: {
      male: share(results.filter((r) => r.sex === 'male' && r.schooling.levelAt27 !== null).map((r) => r.schooling), (s) => rankOf(s.levelAt27) >= rankOf('bachelor')),
      female: share(results.filter((r) => r.sex === 'female' && r.schooling.levelAt27 !== null).map((r) => r.schooling), (s) => rankOf(s.levelAt27) >= rankOf('bachelor')),
    },
    bachelorByIncomeQuarter: [0, 1, 2, 3].map((q) => share(at27.filter((s) => quarter(s) === q), (s) => rankOf(s.levelAt27) >= rankOf('bachelor'))),
    enrolledByIncomeQuarter: [0, 1, 2, 3].map((q) => share(graduates.filter((s) => quarter(s) === q), (s) => s.enrolledRightAway !== null)),
    achievementGap9010: 2.563 * correlation(grade8.map((s) => incomeRankZ(s.incomeAtBirth)), grade8.map((s) => s.standingGrade8!)),
    everEnrolledBy27: share(at27, (s) => s.everEnrolled !== null),
    parentChildEducationCorrelation: correlation(at27.map((s) => s.parentEducationRank), at27.map((s) => rankOf(s.levelAt27))),
    sixYearCompletionFourYear: share(fourYear, (s) => s.yearsToBachelor !== null && s.yearsToBachelor <= 6.1),
    twoYearEntrants: {
      associate: share(twoYear, (s) => s.associateEver || rankOf(s.levelAt27) >= rankOf('associate')),
      transferred: share(twoYear, (s) => s.transferred),
      bachelor: share(twoYear, (s) => rankOf(s.levelAt27) >= rankOf('bachelor')),
    },
    borrowedAmongBachelors: bachelors.length ? borrowers.length / bachelors.length : NaN,
    meanDebtAmongBorrowers: mean(borrowers.map((s) => s.loansAtBachelor!)),
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Rank of each value among all, from 0 to 1. */
function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(xs.length)
  order.forEach(([, i], r) => (out[i] = (r + 0.5) / xs.length))
  return out
}

export function summarizeWork(results: LifeResult[]): WorkSummary {
  // Every year of every life, pooled: one cohort lived through, which is a stationary population.
  const ys = results.flatMap((r) => r.years.map((y) => ({ ...y, sex: r.sex, group: r.ethnicity })))
  const share = (xs: typeof ys, test: (y: (typeof ys)[number]) => boolean): number => (xs.length ? xs.filter(test).length / xs.length : NaN)
  const force = ys.filter((y) => y.age >= 16 && (y.status === 'emp' || y.status === 'unemp'))
  const levels = ['less_than_hs', 'high_school', 'some_college', 'associate', 'bachelor', 'graduate']
  const ft = ys.filter((y) => y.age >= 25 && y.fullTime)
  const weekly = (xs: typeof ys): number => median(xs.map((y) => y.pay / 52))
  const heads = ys.filter((y) => y.head && y.age >= 18)
  const byAge = (lo: number, hi: number): typeof ys => heads.filter((y) => y.age >= lo && y.age <= hi)
  // Mobility, as Chetty et al. measure it: parents' household income averaged over the childhood
  // years, against the child's own income (with a partner's) at 30–34, each ranked in its generation.
  const pairs = results
    .map((r) => {
      const early = r.years.filter((y) => y.age >= 5 && y.age <= 17)
      const later = r.years.filter((y) => y.age >= 30 && y.age <= 34)
      return later.length && early.length ? [early.reduce((a, y) => a + y.hhIncome, 0) / early.length, later.reduce((a, y) => a + y.income, 0) / later.length] : null
    })
    .filter((x): x is number[] => x !== null)
  const pr = ranks(pairs.map((p) => p[0]!))
  const cr = ranks(pairs.map((p) => p[1]!))
  const mp = mean(pr)
  const mc = mean(cr)
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < pr.length; i++) {
    sxy += (pr[i]! - mp) * (cr[i]! - mc)
    sxx += (pr[i]! - mp) ** 2
  }
  const bottom = pr.map((p, i) => [p, cr[i]!]).filter(([p]) => p! < 0.2)
  const years = results.reduce((a, r) => a + r.simulatedYears, 0)
  const groups: Record<string, number> = {}
  for (const g of [...new Set(results.map((r) => r.ethnicity))]) groups[g] = median(byAge(45, 54).filter((y) => y.group === g).map((y) => y.worth))
  return {
    unemployment: share(force, (y) => y.status === 'unemp'),
    unemploymentByEducation: Object.fromEntries(levels.map((l) => [l, share(force.filter((y) => y.age >= 25 && y.education === l), (y) => y.status === 'unemp')])),
    primeAgeEmployment: share(ys.filter((y) => y.age >= 25 && y.age <= 54), (y) => y.status === 'emp'),
    medianWeekly: weekly(ft),
    medianWeeklyByEducation: Object.fromEntries(levels.map((l) => [l, weekly(ft.filter((y) => y.education === l))])),
    womenToMen: weekly(ft.filter((y) => y.sex === 'female')) / weekly(ft.filter((y) => y.sex === 'male')),
    bachelorPremium: weekly(ft.filter((y) => y.education === 'bachelor')) / weekly(ft.filter((y) => y.education === 'high_school')) - 1,
    medianHouseholdIncome: median(heads.map((y) => y.hhIncome)),
    poverty: share(ys, (y) => y.poor),
    medianWorth: median(heads.map((y) => y.worth)),
    medianWorthByAge: { under35: median(byAge(18, 34).map((y) => y.worth)), '35-44': median(byAge(35, 44).map((y) => y.worth)), '45-54': median(byAge(45, 54).map((y) => y.worth)), '55-64': median(byAge(55, 64).map((y) => y.worth)), '65-74': median(byAge(65, 74).map((y) => y.worth)), '75+': median(byAge(75, 200).map((y) => y.worth)) },
    owning: share(heads, (y) => y.housing === 'own'),
    owningUnder35: share(byAge(18, 34), (y) => y.housing === 'own'),
    withParents18to24: share(ys.filter((y) => y.age >= 18 && y.age <= 24), (y) => y.housing === 'parents'),
    withParents25to34: share(ys.filter((y) => y.age >= 25 && y.age <= 34), (y) => y.housing === 'parents'),
    medianRent: median(heads.filter((y) => y.housing === 'rent').map((y) => y.rent)),
    uninsured: share(ys.filter((y) => y.age >= 18 && y.age < 65), (y) => y.cover === 'none'),
    medianTenureYears: median(ys.filter((y) => y.status === 'emp' && y.age >= 16).map((y) => y.tenure / 12)),
    jobsBy56: mean(results.filter((r) => r.jobsBy56 !== null).map((r) => r.jobsBy56!)),
    medianRetirementAge: median(results.filter((r) => r.retiredAt !== null).map((r) => r.retiredAt!)),
    rankSlope: sxy / sxx,
    bottomToTop: bottom.length ? bottom.filter(([, c]) => c! >= 0.8).length / bottom.length : NaN,
    yearsPerRecession: years / Math.max(1, results.reduce((a, r) => a + r.recessions, 0)),
    worthByGroup: groups,
    layoffsWarned: results.reduce((a, r) => a + r.warnedLayoffs, 0) / Math.max(1, results.reduce((a, r) => a + r.layoffs, 0)),
  }
}

export function summarize(results: LifeResult[], content: Prepared, elapsedMs: number): BatchSummary {
  const bySex = {} as BatchSummary['bySex']
  for (const sex of ['male', 'female'] as const) {
    const group = results.filter((r) => r.sex === sex)
    const ages = group.map((r) => r.ageAtDeath)
    const target = tableTargets(content, sex)
    const survival: Record<number, { simulated: number; target: number }> = {}
    for (const age of SURVIVAL_AGES) {
      survival[age] = { simulated: group.filter((r) => r.simulatedYears >= age).length / Math.max(1, group.length), target: target.survival[age]! }
    }
    bySex[sex] = { lives: group.length, lifeExpectancy: mean(ages), standardError: standardError(ages), target: target.lifeExpectancy, survival }
  }

  const totalYears = results.reduce((a, r) => a + r.simulatedYears, 0)
  const stageYears: Record<string, number> = {}
  const stageDecisions: Record<string, number> = {}
  const sources: Record<string, number> = {}
  const variantTotals: Record<string, number> = {}
  const variantMax: Record<string, number> = {}
  let overTwice = 0
  for (const r of results) {
    for (const s in r.yearsInStage) stageYears[s] = (stageYears[s] ?? 0) + r.yearsInStage[s]!
    for (const s in r.decisionsOpened) stageDecisions[s] = (stageDecisions[s] ?? 0) + r.decisionsOpened[s]!
    for (const s in r.significantBySource) sources[s] = (sources[s] ?? 0) + r.significantBySource[s]!
    let any = false
    for (const v in r.variantCounts) {
      const n = r.variantCounts[v]!
      variantTotals[v] = (variantTotals[v] ?? 0) + n
      variantMax[v] = Math.max(variantMax[v] ?? 0, n)
      if (n > 2) any = true
    }
    if (any) overTwice++
  }
  const sourceTotal = Object.values(sources).reduce((a, b) => a + b, 0)

  const cardio: BatchSummary['cardioAt60ByActivity'] = {}
  for (const level of content.bundle.body.activityLevels) {
    const values = results.filter((r) => r.activityAt60 === level.id && r.cardioAt60 !== null).map((r) => r.cardioAt60!)
    cardio[level.id] = { lives: values.length, mean: mean(values) }
  }

  const male = bySex.male.lives
  const tableInfant = (sex: 'male' | 'female'): number => 1 - tableTargets(content, sex).survival[1]!
  return {
    lives: results.length,
    bySex,
    maleShare: male / Math.max(1, results.length),
    infantMortalityPer1000: {
      simulated: (1000 * results.filter((r) => r.simulatedYears < 1).length) / Math.max(1, results.length),
      target: 1000 * ((male * tableInfant('male') + bySex.female.lives * tableInfant('female')) / Math.max(1, results.length)),
    },
    fluPerPersonYear: results.reduce((a, r) => a + r.fluCount, 0) / totalYears,
    decisionsPerYearByStage: Object.fromEntries(Object.keys(stageYears).map((s) => [s, (stageDecisions[s] ?? 0) / stageYears[s]!])),
    significantSourceShares: Object.fromEntries(Object.entries(sources).map(([s, n]) => [s, n / Math.max(1, sourceTotal)])),
    cardioAt60ByActivity: cardio,
    text: {
      feedLinesPerLife: mean(results.map((r) => r.feedLines)),
      distinctVariantsUsed: Object.keys(variantTotals).length,
      mostUsed: Object.entries(variantTotals)
        .map(([variant, total]) => ({ variant, perLife: total / results.length, maxInOneLife: variantMax[variant]! }))
        .sort((a, b) => b.perLife - a.perLife)
        .slice(0, 12),
      livesWithAVariantOverTwice: overTwice / Math.max(1, results.length),
    },
    invariantProblems: [...new Set(results.flatMap((r) => r.invariantProblems))],
    msPerSimulatedYear: elapsedMs / totalYears,
    schooling: summarizeSchooling(results),
    work: summarizeWork(results),
  }
}

export interface BatchOptions {
  lives: number
  seed: string
  strategy: Strategy | 'mixed'
  /** Index of the first life; lets several workers share one batch. Life i always has seed `${seed}-${i}`. */
  from?: number
}

export function runBatch(options: BatchOptions, env: EngineEnv): LifeResult[] {
  const mixed: Strategy[] = ['persona', 'persona', 'persona', 'persona', 'persona', 'persona', 'active', 'sedentary', 'random', 'random']
  const results: LifeResult[] = []
  const from = options.from ?? 0
  for (let i = from; i < from + options.lives; i++) {
    const strategy = options.strategy === 'mixed' ? mixed[i % mixed.length]! : options.strategy
    results.push(runLife(`${options.seed}-${i}`, strategy, env))
  }
  return results
}
