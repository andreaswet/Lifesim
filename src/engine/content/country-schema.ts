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

export const StateDef = z.strictObject({ id: z.string(), name: z.string(), population: z.number().positive() })

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

export const EarningsDef = z.strictObject({
  medianFullTime: z.strictObject({ source: src, byEducation: byEducation(z.number().positive()) }),
  ageProfile: z.strictObject({ source: src, curve: Curve }),
  logSd: z.number().positive(),
  bySex: z.strictObject({ source: src, male: z.number(), female: z.number() }),
  employment: z.strictObject({ source: src, fathers: share, mothers: share, mothersPartTime: share, partTimeEarnings: share }),
  jobLossPerMonth: z.strictObject({ source: src, byEducation: byEducation(share) }),
  jobFindPerMonth: share,
  unemployment: z.strictObject({ incomeShare: share, months: z.number().int() }),
  retirement: z.strictObject({ age: z.number(), incomeShare: share }),
  childSupport: z.strictObject({ source: src, shareOfEarnings: share, paysAtAll: share }),
})
export type EarningsDef = z.infer<typeof EarningsDef>

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
