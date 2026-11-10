/**
 * The game state (design §6).
 *
 * All of it is plain serializable data: no classes, no Maps, string ids. The schemas below are the
 * single definition; the TypeScript types are inferred from them and the same schemas validate
 * imported saves.
 *
 * Each milestone adds fields through save migrations (save.ts). Version 2 (Milestone 2) added
 * families, households, inherited traits and schooling.
 */

import { z } from 'zod'
import { EduLevel } from './content/country-schema'

export const SCHEMA_VERSION = 2
export const ENGINE_VERSION = '0.2.0'

const MonthIndex = z.number().int()
const Scalar = z.union([z.number(), z.string(), z.boolean(), z.null()])
export type Scalar = z.infer<typeof Scalar>

export const Command = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('advance'), until: z.enum(['month', 'season', 'birthday']) }),
  z.strictObject({ type: z.literal('decide'), decisionId: z.string(), optionId: z.string() }),
  z.strictObject({ type: z.literal('setPolicy'), policy: z.strictObject({ activity: z.string().optional(), study: z.string().optional() }) }),
  /** Something the player starts themselves; the available ones are listed in the player's view. */
  z.strictObject({ type: z.literal('act'), action: z.string(), choice: z.string().optional() }),
])
export type Command = z.infer<typeof Command>

export const StartOptions = z.strictObject({
  firstName: z.string().optional(),
  familyName: z.string().optional(),
  sex: z.enum(['male', 'female']).optional(),
  /** Two-letter state id to be born in; drawn by population if omitted. */
  state: z.string().optional(),
  /**
   * Interactive play skips the player character's own death draws before this age. About 0.7% of
   * US children die before five; a life that ends in the first minutes is realistic but is not a
   * game. Batch runs set this to 0 so the statistics stay honest. (Deliberate deviation, recorded
   * in docs/CALIBRATION.md.)
   */
  protectPlayerUntilAge: z.number().int().nonnegative().default(0),
})
export type StartOptions = z.infer<typeof StartOptions>

/** Schooling: where someone is in the system and their record so far (design §7.12). */
const Education = z.strictObject({
  /**
   * not_yet: too young. k12: in school. left_k12: left without a diploma and not enrolled.
   * out: holds a diploma or more and is not enrolled. college: enrolled. not_modeled: an adult
   * whose schooling happened before the simulation began (parents) or before this system existed.
   */
  status: z.enum(['not_yet', 'k12', 'left_k12', 'out', 'college', 'not_modeled']),
  /** Highest level completed. */
  level: EduLevel,
  /** 0 is kindergarten, 12 is twelfth grade. Null when not in school. */
  grade: z.number().int().nullable(),
  school: z.strictObject({ name: z.string(), quality: z.number(), teacher: z.string() }).nullable(),
  courseLevel: z.string(),
  /** Last report card: grade points per subject and overall, and achievement at that moment. */
  lastReport: z.strictObject({ grade: z.number().int(), points: z.record(z.string(), z.number()), gpa: z.number(), skills: z.record(z.string(), z.number()) }).nullable(),
  /** High-school record: sums over the years completed. */
  hs: z.strictObject({ gpaSum: z.number(), years: z.number().int(), rigorSum: z.number() }),
  /** Standing among peers (z) at the last report, kept after leaving school. */
  standing: z.number(),
  test: z.strictObject({ verbal: z.number().int(), math: z.number().int() }).nullable(),
  /** Slow stock, 0–1: how far the pupil has lost touch with school. */
  disengagement: z.number(),
  applications: z.array(z.strictObject({ tier: z.string(), name: z.string(), admitted: z.boolean(), outcomeId: z.string() })),
  /** Where the person has decided to enroll in the autumn. */
  plan: z.strictObject({ tier: z.string(), name: z.string() }).nullable(),
  college: z
    .strictObject({
      tier: z.string(),
      name: z.string(),
      major: z.string(),
      started: MonthIndex,
      partTime: z.boolean(),
      credits: z.number(),
      gradePoints: z.number(),
      gradedCredits: z.number(),
      terms: z.number().int(),
      probation: z.boolean(),
      /** Dollars a year: the price after grants, what the parents give, and what is left uncovered. */
      netPrice: z.number(),
      parentsPay: z.number(),
      unmetNeed: z.number(),
    })
    .nullable(),
  /** Student loans owed, in dollars. Repayment arrives with the money system in Milestone 3. */
  loans: z.number(),
})
export type Education = z.infer<typeof Education>

/** Milestone 2 stand-in for a job: enough for parents to have an income and to lose it. */
const Work = z.strictObject({
  /** Yearly earnings when working the hours below. */
  earnings: z.number(),
  hours: z.enum(['full', 'part', 'none']),
  employed: z.boolean(),
  unemployedSince: MonthIndex.nullable(),
})

const Person = z.strictObject({
  id: z.string(),
  name: z.strictObject({ first: z.string(), family: z.string() }),
  sex: z.enum(['male', 'female']),
  born: MonthIndex,
  /** Day of the month, for prose and for ordering within the birth month. */
  birthDay: z.number().int().min(1).max(31),
  died: z.strictObject({ at: MonthIndex, cause: z.string(), outcomeId: z.string() }).optional(),
  motherId: z.string().nullable(),
  fatherId: z.string().nullable(),
  /** The partner this person lives with, if any. */
  partner: z.strictObject({ id: z.string(), status: z.enum(['married', 'cohabiting']), since: MonthIndex }).nullable(),
  householdId: z.string().nullable(),
  /** Inherited latent values (z-scores): half from each parent plus chance (design §7.5). */
  genes: z.record(z.string(), z.number()),
  /** Aptitudes as z-scores: what genes and early family environment together produced. */
  aptitudes: z.record(z.string(), z.number()),
  /** Big Five personality traits as z-scores. Fixed until Milestone 5. */
  traits: z.record(z.string(), z.number()),
  /** School subjects in grade equivalents. Mastery skills (0–1) arrive with careers. */
  skills: z.record(z.string(), z.number()),
  body: z.strictObject({
    /** Stocks on a 0–1 scale where 1 is the best a well-trained adult at peak age reaches. */
    cardio: z.number(),
    strength: z.number(),
  }),
  /** 0–1: the cost of asking more hours of oneself than there are. Lowers effort and learning. */
  strain: z.number(),
  policies: z.strictObject({ activity: z.string(), study: z.string() }),
  education: Education,
  work: Work.nullable(),
  /** For a mother: the month her next child is due to be born, if one is coming. */
  nextBirth: MonthIndex.nullable(),
  flags: z.record(z.string(), Scalar),
  /** Per event: when it last fired and how often, for `once` and cooldowns. */
  eventHistory: z.record(z.string(), z.strictObject({ last: MonthIndex, count: z.number().int() })),
})
export type Person = z.infer<typeof Person>

/** People who live together and share an income (design §7.11). */
const Household = z.strictObject({
  id: z.string(),
  members: z.array(z.string()),
  /** State id from the country pack. */
  state: z.string(),
  /** Neighborhood income tier, 1 (poorest fifth) to 5. Sets school quality and peers. */
  neighborhood: z.number().int().min(1).max(5),
  /** Yearly income in dollars, recomputed each month from its members. */
  income: z.number(),
  /** 0–1+: recent upheaval at home (a separation, a lost job, a death). Fades over about a year. */
  disruption: z.number(),
  /** How willing the parents are to pay toward college, around 1. */
  collegeWillingness: z.number(),
  schools: z.strictObject({ elementary: z.string(), middle: z.string(), high: z.string(), quality: z.number() }),
})
export type Household = z.infer<typeof Household>

const ProcessInstance = z.strictObject({
  id: z.string(),
  def: z.string(),
  subjectId: z.string(),
  stage: z.string(),
  started: MonthIndex,
  stageEntered: MonthIndex,
  /** First month in which the stage's duration has run out. */
  stageEnds: MonthIndex,
})
export type ProcessInstance = z.infer<typeof ProcessInstance>

const Cost = z.strictObject({ hoursPerWeek: z.number().optional(), money: z.number().optional(), energy: z.enum(['none', 'low', 'moderate', 'high']).optional() })
export type Cost = z.infer<typeof Cost>

const Decision = z.strictObject({
  id: z.string(),
  /**
   * Where the decision comes from: a content event (`event:<id>`), whose options and effects are
   * data, or an engine system (`system:<id>`), which builds its options from the situation.
   */
  source: z.string(),
  subjectId: z.string(),
  class: z.enum(['blocking', 'deferrable']),
  opened: MonthIndex,
  /** Last month in which the decision can still be made; null for blocking decisions. */
  deadline: MonthIndex.nullable(),
  prompt: z.string(),
  options: z.array(z.strictObject({ id: z.string(), label: z.string(), cost: Cost.optional() })),
  /** Optional decisions count toward the interrupt governor's cap. */
  optional: z.boolean(),
})
export type Decision = z.infer<typeof Decision>

const Fact = z.strictObject({
  kind: z.string(),
  subjectId: z.string(),
  month: MonthIndex,
  data: z.record(z.string(), Scalar),
  significant: z.boolean(),
  /** Set when the fact reports a recorded outcome, so the player can ask "Why?". */
  outcomeId: z.string().optional(),
})
export type Fact = z.infer<typeof Fact>

const LifeLogEntry = z.strictObject({
  id: z.string(),
  month: MonthIndex,
  /** The subject's age in whole years when it happened. */
  age: z.number().int(),
  fact: Fact,
  /** Prose as it was shown at the time. Kept so later text changes never rewrite a life. */
  text: z.string(),
  templateId: z.string().optional(),
  /** Hidden entries are things the character did not notice; hindsight may reveal them. */
  hidden: z.boolean(),
  sourceClass: z.enum(['player', 'npc', 'structural', 'chance', 'system']),
})
export type LifeLogEntry = z.infer<typeof LifeLogEntry>

const OutcomeFactor = z.strictObject({
  id: z.string(),
  /** Contribution on the log scale: positive made the outcome more likely. */
  contribution: z.number(),
})

const OutcomeRecord = z.strictObject({
  id: z.string(),
  month: MonthIndex,
  kind: z.string(),
  subjectId: z.string(),
  model: z.enum(['hazard', 'logit']),
  /** Base rate before this person's factors: per year for hazards, per attempt for logit outcomes. */
  base: z.number(),
  baseSource: z.string(),
  factors: z.array(OutcomeFactor),
  /** Probability actually used for the draw (per month for hazards). */
  probability: z.number(),
  context: z.record(z.string(), Scalar),
})
export type OutcomeRecord = z.infer<typeof OutcomeRecord>

/**
 * The cause ledger (design §4.4): per person, per year of life, per stock, the summed contribution
 * of each cause. It answers "what changed this year, and why".
 */
const CauseLedger = z.record(
  z.string(), // person id
  z.record(
    z.string(), // age in years, as a string key
    z.record(z.string(), z.record(z.string(), z.number())), // stock → cause → sum
  ),
)
export type CauseLedger = z.infer<typeof CauseLedger>

export const GameState = z.strictObject({
  meta: z.strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    engineVersion: z.string(),
    contentHash: z.string(),
    seed: z.string(),
    options: StartOptions,
    commandLog: z.array(Command),
  }),
  /** The next month to be simulated. */
  now: MonthIndex,
  phase: z.enum(['alive', 'ended']),
  playerId: z.string(),
  lineage: z.array(z.string()),
  people: z.record(z.string(), Person),
  households: z.record(z.string(), Household),
  processes: z.record(z.string(), ProcessInstance),
  decisions: z.array(Decision),
  log: z.array(LifeLogEntry),
  outcomes: z.record(z.string(), OutcomeRecord),
  ledger: CauseLedger,
  /** Word bands currently shown for each descriptor, so wording has hysteresis. */
  perception: z.record(z.string(), z.record(z.string(), z.string())),
  /** Which text variants were used and when. Read only by the narrator, never by a system. */
  narration: z.strictObject({ lastUsed: z.record(z.string(), MonthIndex), counts: z.record(z.string(), z.number().int()) }),
  nextId: z.number().int(),
})
export type GameState = z.infer<typeof GameState>

export function newId(state: GameState, prefix: string): string {
  const id = `${prefix}${state.nextId}`
  state.nextId += 1
  return id
}

export function player(state: GameState): Person {
  const p = state.people[state.playerId]
  if (!p) throw new Error('Player character missing from state')
  return p
}

export function livingPeople(state: GameState): Person[] {
  // Sorted by id so the order of work never depends on object insertion order.
  return Object.values(state.people)
    .filter((p) => !p.died)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
