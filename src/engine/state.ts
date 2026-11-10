/**
 * The game state (design §6).
 *
 * All of it is plain serializable data: no classes, no Maps, string ids. The schemas below are the
 * single definition; the TypeScript types are inferred from them and the same schemas validate
 * imported saves.
 *
 * Milestone 1 holds only what the engine core needs. Later milestones add fields through save
 * migrations (save.ts).
 */

import { z } from 'zod'

export const SCHEMA_VERSION = 1
export const ENGINE_VERSION = '0.1.0'

const MonthIndex = z.number().int()
const Scalar = z.union([z.number(), z.string(), z.boolean(), z.null()])
export type Scalar = z.infer<typeof Scalar>

export const Command = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('advance'), until: z.enum(['month', 'season', 'birthday']) }),
  z.strictObject({ type: z.literal('decide'), decisionId: z.string(), optionId: z.string() }),
  z.strictObject({ type: z.literal('setPolicy'), policy: z.strictObject({ activity: z.string().optional() }) }),
])
export type Command = z.infer<typeof Command>

export const StartOptions = z.strictObject({
  firstName: z.string().optional(),
  familyName: z.string().optional(),
  sex: z.enum(['male', 'female']).optional(),
  /**
   * Interactive play skips the player character's own death draws before this age. About 0.7% of
   * US children die before five; a life that ends in the first minutes is realistic but is not a
   * game. Batch runs set this to 0 so the statistics stay honest. (Deliberate deviation, recorded
   * in docs/CALIBRATION.md.)
   */
  protectPlayerUntilAge: z.number().int().nonnegative().default(0),
})
export type StartOptions = z.infer<typeof StartOptions>

const Person = z.strictObject({
  id: z.string(),
  name: z.strictObject({ first: z.string(), family: z.string() }),
  sex: z.enum(['male', 'female']),
  born: MonthIndex,
  /** Day of the month, for prose and for ordering within the birth month. */
  birthDay: z.number().int().min(1).max(31),
  died: z.strictObject({ at: MonthIndex, cause: z.string(), outcomeId: z.string() }).optional(),
  body: z.strictObject({
    /** Stocks on a 0–1 scale where 1 is the best a well-trained adult at peak age reaches. */
    cardio: z.number(),
    strength: z.number(),
  }),
  policies: z.strictObject({ activity: z.string() }),
  flags: z.record(z.string(), Scalar),
  /** Per event: when it last fired and how often, for `once` and cooldowns. */
  eventHistory: z.record(z.string(), z.strictObject({ last: MonthIndex, count: z.number().int() })),
})
export type Person = z.infer<typeof Person>

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

const Decision = z.strictObject({
  id: z.string(),
  eventId: z.string(),
  subjectId: z.string(),
  class: z.enum(['blocking', 'deferrable']),
  opened: MonthIndex,
  /** Last month in which the decision can still be made; null for blocking decisions. */
  deadline: MonthIndex.nullable(),
  prompt: z.string(),
  options: z.array(z.strictObject({ id: z.string(), label: z.string() })),
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
  model: z.enum(['hazard', 'choice']),
  /** Base rate before this person's factors. For hazards, per year. */
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
