/**
 * Schemas for the country pack's family, earnings and education data (design §12.4). The data
 * files under content/countries/<id>/ are the documentation for what each number means; these
 * schemas only fix their shape.
 */

import { z } from 'zod'

export const EDU_LEVELS = ['less_than_hs', 'high_school', 'some_college', 'associate', 'bachelor', 'graduate'] as const
export const EduLevel = z.enum(EDU_LEVELS)
export type EduLevel = z.infer<typeof EduLevel>

const src = z.string().min(1)
const share = z.number().min(0).max(1)
const byEducation = <T extends z.ZodType>(value: T) => z.strictObject(Object.fromEntries(EDU_LEVELS.map((l) => [l, value])) as Record<EduLevel, T>)
const Curve = z.array(z.tuple([z.number(), z.number()])).min(2)

export const StateDef = z.strictObject({
  id: z.string(),
  name: z.string(),
  population: z.number().positive(),
  /** Regional price parity: 100 is the national price level. */
  rpp: z.number().positive(),
  /** Median gross rent a month and median home value, in start-year dollars. */
  rent: z.number().positive(),
  home: z.number().positive(),
  /** Effective state income tax on a median income, and effective property tax on a home's value, in percent. */
  incomeTax: z.number().min(0),
  propertyTax: z.number().min(0),
  /** Hourly minimum wage, and the most unemployment insurance pays in a week. */
  minWage: z.number().positive(),
  uiMax: z.number().positive(),
  /** Whether the state has expanded Medicaid to low-income adults. */
  medicaid: z.boolean(),
})

export const FamilyDef = z.strictObject({
  motherEducation: z.strictObject({ source: src, shares: byEducation(share) }),
  motherAge: z.strictObject({ source: src, sd: z.number().positive(), min: z.number(), max: z.number(), byEducation: byEducation(z.strictObject({ mean: z.number(), min: z.number() })) }),
  partnership: z.strictObject({ source: src, unmarriedByEducation: byEducation(share), cohabitingShareOfUnmarried: share }),
  birthOrder: z.strictObject({ source: src, shares: z.array(share).min(1), spacingYears: z.tuple([z.number(), z.number()]) }),
  father: z.strictObject({ source: src, ageGap: z.strictObject({ mean: z.number(), sd: z.number() }), minAge: z.number(), sameEducation: share, adjacentEducation: share }),
  separation: z.strictObject({
    source: src,
    perYear: z.strictObject({ married: share, cohabiting: share }),
    eitherParentUnemployed: z.number(),
    motherUnder25AtBirth: z.number(),
    childrenStayWithMother: share,
  }),
  furtherBirth: z.strictObject({ source: src, probabilityByParity: z.array(share).min(1), gapMonths: z.tuple([z.number().int(), z.number().int()]), maxMotherAge: z.number(), afterSeparation: share }),
  parenting: z.strictObject({
    source: src,
    involvement: z.strictObject({ education: z.number(), conscientiousness: z.number(), agreeableness: z.number(), fullTimeWork: z.number(), unemployed: z.number(), loneParent: z.number() }),
    homeSupport: z.strictObject({ parentEducation: z.number(), income: z.number(), involvement: z.number(), scale: z.number().positive() }),
  }),
  inheritance: z.strictObject({
    source: src,
    aptitude: z.strictObject({ genes: share, family: share }),
    personality: z.strictObject({ genes: share }),
    generalFactor: share,
    aptitudeByEducation: byEducation(z.number()),
    conscientiousnessByEducation: byEducation(z.number()),
  }),
  neighborhood: z.strictObject({ source: src, incomeWeight: share, schoolQualityPerTier: z.number(), schoolQualityNoise: z.number() }),
  poverty: z.strictObject({ source: src, base: z.number(), perAdditional: z.number() }),
})
export type FamilyDef = z.infer<typeof FamilyDef>

/** Who people are (design decision Q1): the groups a person may belong to and what differs between them at birth. */
export const PeopleDef = z.strictObject({
  source: src,
  /** Chance that both parents belong to the same group. */
  sameGroup: share,
  groups: z
    .array(
      z.strictObject({
        id: z.string(),
        label: z.string(),
        /** Share of births. */
        share,
        motherEducation: byEducation(share),
        /** Added to the log-odds that a birth is to an unmarried mother, given her schooling. */
        unmarried: z.number(),
        /** Median net worth relative to other families of the same income, age and schooling. */
        wealth: z.number().positive(),
        /** Added to the log-odds of owning a home, given income and age. */
        owning: z.number(),
      }),
    )
    .min(1),
})
export type PeopleDef = z.infer<typeof PeopleDef>

const Regime = z.strictObject({ unemployment: z.number(), inflation: z.number(), stockMean: z.number(), stockSd: z.number(), housing: z.number() })

/** The economy (design §7.1): a business cycle and what it drives. Rates are in percent a year unless a name says otherwise. */
export const EconomyDef = z.strictObject({
  source: src,
  cycle: z.strictObject({
    source: src,
    /** Chance per month that an expansion ends, and how much it grows with each month the expansion has lasted. */
    recessionBase: share,
    recessionPerMonth: z.number(),
    recessionMinMonths: z.number().int(),
    recessionEndPerMonth: share,
    severeShare: share,
    severeEndPerMonth: share,
    recoveryMonths: z.number().int(),
  }),
  regimes: z.strictObject({ expansion: Regime, recession: Regime, severe: Regime, recovery: Regime }),
  unemployment: z.strictObject({ source: src, reference: z.number(), riseMonths: z.number(), fallMonths: z.number() }),
  inflation: z.strictObject({ source: src, revertMonths: z.number(), noise: z.number(), spikePerMonth: share, spikeSize: z.tuple([z.number(), z.number()]), spikeFadeMonths: z.number() }),
  wages: z.strictObject({ source: src, neutralUnemployment: z.number(), perPointOfUnemployment: z.number(), lagMonths: z.number(), regional: share }),
  rates: z.strictObject({
    source: src,
    realNeutral: z.number(),
    inflationWeight: z.number(),
    unemploymentWeight: z.number(),
    smoothingMonths: z.number(),
    mortgageBase: z.number(),
    mortgagePolicyWeight: z.number(),
    cardSpread: z.number(),
    savingsShare: share,
    studentLoan: z.number(),
    bondSpread: z.number(),
    bondDuration: z.number(),
  }),
  stocks: z.strictObject({ source: src, fatTailChance: share, fatTailScale: z.number() }),
  housing: z.strictObject({ source: src, noise: z.number(), momentum: share }),
  sectors: z.array(z.strictObject({ id: z.string(), label: z.string(), cyclical: z.number(), trend: z.number(), noise: z.number() })).min(1),
})
export type EconomyDef = z.infer<typeof EconomyDef>

const Occupation = z.strictObject({
  id: z.string(),
  title: z.string(),
  sector: z.string(),
  /** Least schooling an employer asks for. */
  education: EduLevel,
  /** Median yearly pay for full-time work in start-year dollars, and the spread of log pay within the occupation. */
  pay: z.number().positive(),
  spread: z.number().positive().default(0.3),
  /** Thousands employed: how common the work is among people who qualify for it. */
  employment: z.number().positive(),
  /** Share of the people doing it who are women; drives who looks for it, not what it pays. */
  female: share,
  hours: z.number().positive().default(40),
  partTime: share.default(0.15),
  /** How much the work leans on quantitative rather than verbal ability, and on dealing with people. */
  math: share.default(0.3),
  people: share.default(0.3),
  physical: share.default(0.2),
  stress: share.default(0.4),
  cyclical: z.number().default(1),
  /** Chance that a job in this occupation comes with health insurance, and with a retirement plan. */
  insured: share,
  retirement: share,
  pension: z.boolean().default(false),
  /** A license or qualification the work requires. */
  credential: z.string().optional(),
  /** College majors that lead to it, where the degree has to be in a field. */
  majors: z.array(z.string()).optional(),
  /** Paid training on the job that ends with the credential: an apprenticeship, an academy, a residency. */
  trainee: z.strictObject({ title: z.string(), months: z.number().int().positive(), pay: share }).optional(),
  /** Years of work of any kind needed before anyone is put in charge. */
  experienceYears: z.number().default(0),
  /** Open to people under eighteen. */
  youth: z.boolean().default(false),
})
export type OccupationDef = z.infer<typeof Occupation>

const Level = z.strictObject({ id: z.string(), label: z.string(), description: z.string() })

/** The labor market (design §7.13). */
export const LaborDef = z.strictObject({
  source: src,
  occupations: z.array(Occupation).min(10),
  /** Rungs within an occupation: pay relative to its median, and the months and skill needed to reach each. */
  ladder: z.array(z.strictObject({ id: z.string(), prefix: z.string(), pay: z.number().positive(), months: z.number(), skill: share })).min(2),
  employers: z.strictObject({
    names: z.strictObject({ first: z.array(z.string()).min(5), bySector: z.record(z.string(), z.array(z.string()).min(1)), managers: z.array(z.string()).min(5) }),
    paySd: z.number(),
    trouble: z.strictObject({
      source: src,
      /** Chance per month that a sound employer gets into difficulty, by the schooling its jobs ask of this worker. */
      perMonth: byEducation(share),
      /** How much each point of unemployment above the reference rate multiplies that chance. */
      perPointOfUnemployment: z.number(),
      quietMonths: z.tuple([z.number().int(), z.number().int()]),
      recoverPerMonth: share,
      layoffsPerMonth: share,
      /** Once layoffs begin: how long they go on, each worker's chance per month, and the chance the employer closes. */
      layoffMonths: z.tuple([z.number().int(), z.number().int()]),
      laidOffPerMonth: share,
      closes: share,
      signalPerMonth: share,
    }),
  }),
  search: z.strictObject({
    source: src,
    applicationsPerMonth: z.number(),
    /** Chance that one application ends in an offer, for an ordinary candidate in an ordinary market. */
    offerPerApplication: share,
    perPointOfUnemployment: z.number(),
    sector: z.number(),
    experience: z.number(),
    firstJob: z.number(),
    perSixMonthsOut: z.number(),
    perDecadeOver50: z.number(),
    interview: z.number(),
    fit: z.number(),
    callbacks: z.strictObject({ source: src, byGroup: z.record(z.string(), z.number()) }),
    /** Chance per month that someone in work, and open to it, hears of something better; by age. */
    outsideOffer: Curve,
    outsideRaise: z.tuple([z.number(), z.number()]),
    /** How strongly people favour work typical of their own sex when choosing what to look for. */
    sexTyping: z.number(),
    levels: z.array(Level.extend({ applications: z.number(), outside: z.number() })).min(2),
    default: z.string(),
  }),
  pay: z.strictObject({
    source: src,
    personalSd: z.number(),
    fit: z.number(),
    background: z.number(),
    offerNoise: z.number(),
    partTimeHourly: share,
    merit: z.number(),
    typicalPerformance: share,
    negotiate: z.strictObject({ source: src, succeeds: share, withdrawn: share, gain: z.tuple([z.number(), z.number()]) }),
  }),
  performance: z.strictObject({
    fit: z.number(),
    conscientiousness: z.number(),
    skill: z.number(),
    strain: z.number(),
    noise: z.number(),
    months: z.number(),
    promote: share,
    toManagement: share,
    warnBelow: share,
    dismissedPerMonth: share,
    levels: z.array(Level.extend({ effort: z.number(), hours: z.number() })).min(2),
    default: z.string(),
  }),
  skill: z.strictObject({ source: src, perMonth: z.number(), power: z.number(), aptitude: z.number(), fadeMonths: z.number(), retained: share, related: share }),
  separations: z.strictObject({ source: src, quitPerMonth: Curve, suddenPerMonth: share, firstYear: z.number(), tenureShield: z.number().positive() }),
  participation: z.strictObject({
    source: src,
    fathers: share,
    mothers: share,
    mothersPartTime: share,
    teens: Curve,
    students: share,
    /** Chance per year of stopping work for good, by age, for people who can afford to. */
    retire: Curve,
    stopBy: z.number(),
    stepOut: z.strictObject({ female: share, male: share, alone: z.number(), backAlone: z.number(), fromAge: z.number(), untilAge: z.number() }),
    stepBack: share,
  }),
  unemploymentInsurance: z.strictObject({ source: src, replacement: share, weeks: z.number(), minMonths: z.number() }),
  childSupport: z.strictObject({ source: src, shareOfEarnings: share, paysAtAll: share }),
  /** Courses that end in a credential: certificates and graduate degrees (design §7.12). */
  programs: z
    .array(
      z.strictObject({
        id: z.string(),
        label: z.string(),
        kind: z.enum(['certificate', 'graduate']),
        credential: z.string(),
        needs: EduLevel,
        majors: z.array(z.string()).optional(),
        months: z.number().int().positive(),
        /** Tuition and fees a year, start-year dollars. */
        cost: z.number().nonnegative(),
        /** Admission: the college grade average at which half of applicants get in (graduate programs only). */
        bar: z.number().optional(),
        completes: share,
        /** How many of those eligible start it in a given year, relative to the others. */
        weight: z.number().nonnegative(),
        source: src,
      }),
    )
    .min(1),
  programEntry: z.strictObject({ source: src, certificatePerYear: share, graduatePerYear: share, untilAge: z.number() }),
  /** College majors whose bachelor's degree carries a credential with it. */
  degreeCredentials: z.record(z.string(), z.string()),
})
export type LaborDef = z.infer<typeof LaborDef>

const Brackets = z.array(z.tuple([z.number(), z.number()])).min(1)
const byStatus = <T extends z.ZodType>(value: T) => z.strictObject({ single: value, joint: value, head: value })

/** Federal taxes and the retirement system (design §7.14, §7.13). Dollar figures are start-year dollars and are indexed to prices. */
export const TaxDef = z.strictObject({
  source: src,
  asOf: z.number().int(),
  standardDeduction: byStatus(z.number()),
  /** [rate, taxable income up to which it applies]; the last row's limit is ignored. */
  brackets: byStatus(Brackets),
  payroll: z.strictObject({ socialSecurity: share, medicare: share, wageBase: z.number() }),
  childCredit: z.strictObject({ perChild: z.number(), refundable: z.number(), earnedAbove: z.number(), refundRate: share, phaseOut: byStatus(z.number()), underAge: z.number().int() }),
  earnedIncomeCredit: z.strictObject({
    source: src,
    /** By number of children (0 to 3 or more): the most it pays, the rate it builds at, where it starts to shrink, and how fast. */
    byChildren: z.array(z.strictObject({ max: z.number(), phaseIn: share, phaseOutStart: z.number(), phaseOutStartJoint: z.number(), phaseOut: share })).length(4),
    childlessAges: z.tuple([z.number(), z.number()]),
  }),
  benefitsTaxableShare: share,
  socialSecurity: z.strictObject({
    source: src,
    bendPoints: z.tuple([z.number(), z.number()]),
    rates: z.tuple([share, share, share]),
    years: z.number().int(),
    fullAge: z.number(),
    earliestAge: z.number(),
    latestAge: z.number(),
    /** Share of the full benefit cut per month claimed early (first three years, then beyond), and added per month of delay. */
    earlyPerMonth: z.tuple([z.number(), z.number()]),
    delayedPerMonth: z.number(),
  }),
})
export type TaxDef = z.infer<typeof TaxDef>

/** Household money (design §7.14, §7.2): costs of living, housing, credit, benefits and saving. Dollars are start-year dollars. */
export const MoneyDef = z.strictObject({
  source: src,
  living: z.strictObject({
    source: src,
    /** Food, utilities, transport and the rest of what cannot be gone without, as a share of the poverty line for the household. */
    essentials: share,
    childcare: z.strictObject({ source: src, perChild: z.number(), underAge: z.number(), shareOfIncome: share }),
    levels: z.array(Level.extend({ spends: z.number() })).min(2),
    default: z.string(),
  }),
  saving: z.strictObject({
    source: src,
    levels: z.array(Level.extend({ retirement: share, invests: z.boolean(), bufferMonths: z.number() })).min(2),
    /** Share of retirement savings spent each year once retired, by age. */
    drawdown: Curve,
    /** Share of other savings spent each year, by age: the wealth effect on spending. */
    wealthSpending: Curve,
    default: z.string(),
    matchRate: z.tuple([z.number(), z.number()]),
    stockShare: Curve,
  }),
  health: z.strictObject({
    source: src,
    employer: z.strictObject({ single: z.number(), family: z.number() }),
    marketplace: z.strictObject({ benchmark: z.number(), ageFactor: Curve, contribution: Curve, buysIfUnder: share }),
    /** Share of people who go without cover they could have, even when it costs nothing. */
    neverEnroll: share,
    /** Average yearly cost of care in old age, out of pocket, by age. */
    lateLifeCare: Curve,
    medicaid: z.strictObject({ adults: z.number(), children: z.number() }),
    medicare: z.strictObject({ age: z.number(), premium: z.number(), helpBelow: z.number() }),
    outOfPocket: z.strictObject({ insured: z.number(), publicCover: z.number(), uninsured: z.number(), medicare: z.number(), child: z.number() }),
  }),
  snap: z.strictObject({ source: src, grossLimit: z.number(), maxMonthly: z.array(z.number()).min(1), perAdditional: z.number(), deduction: z.number(), earnedDeduction: share, benefitReduction: share }),
  housing: z.strictObject({
    source: src,
    rentByTier: z.array(z.number()).length(5),
    priceByTier: z.array(z.number()).length(5),
    perExtraPerson: z.number(),
    sharedRent: share,
    depositMonths: z.number(),
    incomeToRent: z.number(),
    minScore: z.number(),
    evictionAfterMonths: z.number().int(),
    /** Monthly chance that someone behind on the rent moves in with family rather than wait for eviction. */
    doubleUp: share,
    recordYears: z.number(),
    guestRent: share,
    upkeep: z.number(),
    closingCosts: share,
    sellingCosts: share,
    mortgage: z.strictObject({ termMonths: z.number().int(), minDown: share, fullDown: share, maxDebtToIncome: share, minScore: z.number(), insurance: z.number(), foreclosureAfterMonths: z.number().int(), forcedSale: share }),
    /** Help from parents with a first down payment: at most this share of the price, and of their savings. */
    gift: z.strictObject({ source: src, ofPrice: share, ofSavings: share }),
    /** Renters of these ages who save at all set aside this extra share of what is left each month toward a home. */
    savingForHome: z.strictObject({ share, fromAge: z.number(), untilAge: z.number() }),
    retirementLoan: z.strictObject({ share, max: z.number() }),
    approval: z.strictObject({ source: src, base: z.number(), perScore50: z.number(), perDebtPoint: z.number(), thinDown: z.number(), byGroup: z.record(z.string(), z.number()) }),
    /** How often other people take these steps, per year, when they are able to. */
    movesOut: Curve,
    buys: Curve,
    ownsAtStart: z.strictObject({ source: src, base: z.number(), perAgeYear: z.number(), perIncomeLog: z.number() }),
  }),
  credit: z.strictObject({
    source: src,
    floor: z.number(),
    range: z.number(),
    weights: z.strictObject({ history: share, utilization: share, age: share, marks: share }),
    historyMonths: z.number(),
    missedPayment: share,
    markYears: z.number(),
    fullAgeYears: z.number(),
    limitShare: z.tuple([share, share]),
    minimumPayment: share,
    aprPer100: z.number(),
    chargeOffMonths: z.number().int(),
    closedAfterMarkMonths: z.number().int(),
  }),
  studentLoans: z.strictObject({ source: src, graceMonths: z.number().int(), termMonths: z.number().int(), incomeShare: share, protectedIncome: z.number(), forgivenAfterMonths: z.number().int(), privateShare: share, privateSpread: z.number() }),
  wealthAtStart: z.strictObject({ source: src, byAge: Curve, medianIncome: z.number(), incomeElasticity: z.number(), logSd: z.number(), cash: share, retirement: share }),
  pension: z.strictObject({ source: src, perYear: share, fromAge: z.number() }),
})
export type MoneyDef = z.infer<typeof MoneyDef>

const Tier = z.strictObject({
  id: z.string(),
  label: z.string(),
  years: z.number().int(),
  credential: z.enum(['associate', 'bachelor']),
  open: z.boolean(),
  bar: z.number(),
  slope: z.number().positive(),
  difficulty: z.number(),
  prestige: z.number(),
  partTimeShare: share,
  netPrice: z.array(z.number().nonnegative()).length(5),
  source: src,
  names: z.array(z.string()).min(1),
})
export type TierDef = z.infer<typeof Tier>

const Weighted = z.strictObject({ base: z.number(), aspiration: z.number() })

export const EducationDef = z.strictObject({
  k12: z.strictObject({
    entryAge: z.number().int(),
    schoolMonths: z.array(z.number().int().min(1).max(12)),
    subjects: z.array(z.strictObject({ id: z.string(), aptitude: z.string(), label: z.string() })).min(1),
    crossAptitude: share,
    readiness: z.strictObject({ aptitude: z.number(), home: z.number(), noise: z.number(), sd: z.number() }),
    learning: z.strictObject({ aptitude: z.number(), effort: z.number(), school: z.number(), home: z.number(), disruption: z.number(), strain: z.number(), yearNoise: z.number(), courseFit: z.number() }),
    summer: z.strictObject({ base: z.number(), home: z.number() }),
    study: z.strictObject({
      levels: z.array(z.strictObject({ id: z.string(), label: z.string(), description: z.string(), hoursPerWeek: z.number(), effort: z.number() })).min(2),
      default: z.string(),
      choiceFromAge: z.number().int(),
      conscientiousness: z.number(),
      parentalStructure: z.number(),
      strain: z.number(),
      engagementBySex: z.strictObject({ source: src, female: z.number(), male: z.number() }),
    }),
    load: z.strictObject({ freeHours: z.number(), perConscientiousness: z.number(), strainRiseMonths: z.number(), strainFallMonths: z.number(), fullStrainAtExtraHours: z.number() }),
    grades: z.strictObject({ source: src, mean: z.number(), achievement: z.number(), effort: z.number(), noise: z.number() }),
    courseLevels: z.array(z.strictObject({ id: z.string(), label: z.string(), fromGrade: z.number().int(), recommendedZ: z.number(), gradePenalty: z.number(), rigor: z.number() })).min(1),
    disengagement: z.strictObject({ months: z.number(), failing: z.number(), lowAchievement: z.number(), disruption: z.number(), lowInvolvement: z.number(), conscientiousness: z.number() }),
    dropout: z.strictObject({ source: src, minAge: z.number().int(), perMonthAtZero: z.number(), steepness: z.number(), promptAbove: z.number() }),
    graduationGpa: z.number(),
    equivalency: z.strictObject({ source: src, perMonth: share, untilAge: z.number() }),
  }),
  test: z.strictObject({ name: z.string(), source: src, grade: z.number().int(), month: z.number().int(), sectionMean: z.number(), sectionSd: z.number(), reliability: share, fee: z.number() }),
  admissions: z.strictObject({
    gpaMean: z.number(),
    gpaSd: z.number(),
    testMean: z.number(),
    testSd: z.number(),
    weights: z.strictObject({ gpa: z.number(), test: z.number(), rigor: z.number() }),
    noTestPenalty: z.number(),
    competitionSd: z.number(),
    month: z.number().int(),
    decideByMonth: z.number().int(),
    applyMonth: z.number().int(),
    strategies: z.array(z.strictObject({ id: z.string(), label: z.string(), tiers: z.array(z.string()), fee: z.number() })).min(2),
  }),
  incomeBands: z.array(z.number()).length(4),
  tiers: z.array(Tier).min(2),
  majors: z.array(z.strictObject({ id: z.string(), label: z.string(), difficulty: z.number(), math: share })).min(1),
  college: z.strictObject({
    creditsPerTerm: z.number(),
    partTimeCredits: z.number(),
    creditsFor: z.strictObject({ associate: z.number(), bachelor: z.number() }),
    grades: z.strictObject({ mean: z.number(), preparation: z.number(), effort: z.number(), unmetNeed: z.number(), noise: z.number() }),
    creditsEarned: Curve,
    probationBelow: z.number(),
    dismissalBelow: z.number(),
    changeMajorCredits: z.number(),
    leaving: z.strictObject({
      source: src,
      base: z.number(),
      lowGpa: z.number(),
      unmetNeedPer5000: z.number(),
      partTime: z.number(),
      communityCollege: z.number(),
      conscientiousness: z.number(),
      firstGeneration: z.number(),
      perTermBeyondNormal: z.number(),
    }),
    lateEntry: z.strictObject({ source: src, fromAge: z.number(), untilAge: z.number(), base: z.number(), aspiration: z.number(), perYearAway: z.number(), communityShare: share, applyStrategy: z.string() }),
    transfer: z.strictObject({ source: src, minCredits: z.number(), minGpa: z.number(), tiers: z.array(z.string()) }),
  }),
  paying: z.strictObject({
    parents: z.strictObject({ source: src, incomeFloor: z.number(), shareAboveFloor: share, willingnessSd: z.number(), willingnessPerEducationStep: z.number() }),
    loans: z.strictObject({ source: src, byYear: z.array(z.number()).min(1), aggregate: z.number(), borrowIfGapAbove: z.number() }),
    ownEarnings: z.number(),
  }),
  choices: z.strictObject({
    source: src,
    aspiration: z.strictObject({ base: z.number(), gpa: z.number(), parentEducation: z.number(), income: z.number(), noise: z.number() }),
    strategy: z.record(z.string(), Weighted),
    enroll: z.strictObject({ fourYear: z.number(), prestige: z.number(), aspiration: z.number(), costPer5000: z.number(), community: z.number(), none: z.number(), noneAspiration: z.number() }),
    takeTest: Weighted,
  }),
})
export type EducationDef = z.infer<typeof EducationDef>

const Norm = z.strictObject({ mean: z.array(z.number()).length(13), sd: z.array(z.number().positive()).length(13) })
export const NormsDef = z.strictObject({ source: src }).catchall(Norm)
export type NormsDef = z.infer<typeof NormsDef>

export const SchoolNamesDef = z.strictObject({
  elementary: z.array(z.string()).min(1),
  middle: z.array(z.string()).min(1),
  high: z.array(z.string()).min(1),
  teachers: z.array(z.string()).min(1),
})
