/**
 * Schemas for authored content. The TypeScript types are inferred from these, so the data files,
 * the validator and the engine can never disagree about shape.
 *
 * Everything here is plain data. Expressions are kept as strings in the bundle and compiled when
 * the engine prepares the content (see prepare.ts).
 */

import { z } from 'zod'
import { EconomyDef, EducationDef, FamilyDef, LaborDef, MoneyDef, NormsDef, PeopleDef, SchoolNamesDef, StateDef, TaxDef } from './country-schema'

/** An expression in the content language. YAML numbers and booleans are accepted and stringified. */
const Expr = z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v))

const Id = z.string().regex(/^[a-z][a-z0-9_.]*$/, 'ids are lower-case words joined by dots or underscores')

export const STOCK_IDS = ['cardio', 'strength'] as const
export const StockId = z.enum(STOCK_IDS)
export type StockId = z.infer<typeof StockId>

export const SOURCE_CLASSES = ['player', 'npc', 'structural', 'chance'] as const

const FactSpec = z.strictObject({
  kind: Id,
  /** Field name → expression, evaluated when the fact is emitted. */
  data: z.record(z.string(), Expr).default({}),
  /** Significant facts are candidates for the year summary and get a "Why?" where one exists. */
  significant: z.boolean().default(false),
})
export type FactSpec = z.infer<typeof FactSpec>

/** The fixed vocabulary of things content may do to state (design §9.4). */
const Effect = z.union([
  z.strictObject({ adjust: z.strictObject({ stock: StockId, delta: Expr, cause: Id }) }),
  z.strictObject({ setPolicy: z.strictObject({ activity: Id.optional(), study: Id.optional(), effort: Id.optional(), search: Id.optional(), lifestyle: Id.optional(), saving: Id.optional() }) }),
  z.strictObject({ setFlag: z.strictObject({ name: Id, value: Expr }) }),
  z.strictObject({ startProcess: Id }),
  z.strictObject({ emit: FactSpec }),
  /** Calls a named piece of engine logic, where an outcome needs the engine's own models. */
  z.strictObject({ run: Id }),
])
export type Effect = z.infer<typeof Effect>

const HazardFactor = z.strictObject({
  id: Id,
  /** Size of the factor for this person; multiplied by beta on the log scale. */
  value: Expr.default('1'),
  when: Expr.optional(),
  beta: z.number(),
})

const Hazard = z.strictObject({
  base: z.strictObject({
    perYear: z.number().positive(),
    population: z.string().min(1),
    source: z.string().min(1),
    asOf: z.union([z.number(), z.string()]),
  }),
  factors: z.array(HazardFactor).default([]),
  /**
   * Population mean of exp(sum of factor terms). Dividing by it keeps the simulated population on
   * the declared base rate (design §3.2). The batch tool reports what it should be.
   */
  normalization: z.number().positive().default(1),
})
export type Hazard = z.infer<typeof Hazard>

const Cost = z.strictObject({
  hoursPerWeek: z.number().optional(),
  money: z.number().optional(),
  energy: z.enum(['none', 'low', 'moderate', 'high']).optional(),
})

const DecisionOption = z.strictObject({
  id: Id,
  label: z.string().min(1),
  cost: Cost.optional(),
  effects: z.array(Effect).default([]),
  fact: FactSpec.optional(),
  /** Relative weight when the character decides for themselves (lapsed deadline, AI player). */
  autoWeight: Expr.default('1'),
})

const DecisionSpec = z.strictObject({
  class: z.enum(['blocking', 'deferrable']),
  /** Months until a deferrable decision lapses. Blocking decisions have no deadline. */
  deadlineMonths: z.number().int().positive().default(1),
  /** Id of the text that presents the decision. */
  prompt: Id,
  options: z.array(DecisionOption).min(2),
})
export type DecisionSpec = z.infer<typeof DecisionSpec>

const EventDef = z.strictObject({
  id: Id,
  /** Which source of events this belongs to, for the mix measured in design §9.1. */
  sourceClass: z.enum(SOURCE_CLASSES),
  /** Life stages this can apply to; used to index events. Omitted means all. */
  stages: z.array(Id).optional(),
  when: Expr.default('true'),
  once: z.boolean().default(false),
  cooldownMonths: z.number().int().nonnegative().default(0),
  /** With a hazard the event is a monthly draw; without one it fires as soon as `when` holds. */
  hazard: Hazard.optional(),
  /** Optional events may be held back by the interrupt governor in a crowded year. */
  optional: z.boolean().default(false),
  effects: z.array(Effect).default([]),
  fact: FactSpec.optional(),
  decision: DecisionSpec.optional(),
})
export type EventDef = z.infer<typeof EventDef>

const ProcessSignal = z.strictObject({
  id: Id,
  /** Whether the character notices. Unnoticed signals are logged hidden, for hindsight. */
  notice: Expr.default('true'),
  /** Chance per month that the signal shows at all while in this stage. */
  monthlyChance: z.number().min(0).max(1).default(1),
  fact: FactSpec,
})

const ProcessTransition = z.strictObject({
  to: Id,
  when: Expr.optional(),
  /** Monthly probability, as an expression. Omitted means certain once `when` holds. */
  hazard: Expr.optional(),
})

const ProcessStage = z.strictObject({
  id: Id,
  /** How the stage reads in the status area while it lasts, e.g. "Down with the flu". */
  status: z.string().optional(),
  duration: z.strictObject({ months: z.tuple([z.number().int().positive(), z.number().int().positive()]) }),
  onEnter: z.array(Effect).default([]),
  monthly: z.array(Effect).default([]),
  onExit: z.array(Effect).default([]),
  signals: z.array(ProcessSignal).default([]),
  transitions: z.array(ProcessTransition).default([]),
  /** Stage entered when the duration runs out; "end" finishes the process. */
  next: Id.default('end'),
})

const ProcessDef = z.strictObject({
  id: Id,
  stages: z.array(ProcessStage).min(1),
})
export type ProcessDef = z.infer<typeof ProcessDef>

const TextVariant = z.strictObject({
  when: Expr.optional(),
  weight: z.number().positive().default(1),
  /** A last resort: used only when no ordinary variant's condition holds. */
  fallback: z.boolean().default(false),
  text: z.string().min(1),
})

const TextDef = z.strictObject({
  id: Id,
  /** The fact kind this template renders. Templates without one are fetched by id (prompts). */
  fact: Id.optional(),
  when: Expr.default('true'),
  variants: z.array(TextVariant).min(1),
})
export type TextDef = z.infer<typeof TextDef>

const DescriptorDef = z.strictObject({
  id: Id,
  /** How far past a boundary the value must move before the wording changes. */
  margin: z.number().nonnegative().default(0),
  /**
   * From this age a change of band is reported as a fact ("stairs leave you winded"). Omitted
   * means the descriptor only ever words the status area.
   */
  notableFromAge: z.number().int().nonnegative().optional(),
  /** In ascending order; the last band needs no upper bound. */
  bands: z
    .array(z.strictObject({ id: Id, upTo: z.number().optional(), text: z.string().min(1) }))
    .min(2),
})
export type DescriptorDef = z.infer<typeof DescriptorDef>

const StageDef = z.strictObject({ id: Id, fromAge: z.number().int().nonnegative(), label: z.string() })

const Curve = z.array(z.tuple([z.number(), z.number()])).min(2)

const StockDef = z.strictObject({
  /** Capacity by age, as a fraction of the lifetime peak. */
  envelope: Curve,
  tauUpMonths: z.number().positive(),
  tauDownMonths: z.number().positive(),
  atBirth: z.number().min(0).max(1),
})

const ActivityLevel = z.strictObject({
  id: Id,
  label: z.string(),
  description: z.string(),
  hoursPerWeek: z.number().nonnegative(),
  /** Fraction of the age envelope this level sustains, per stock. */
  sustains: z.record(StockId, z.number().min(0).max(1)),
})

const BodyDef = z.strictObject({
  stocks: z.record(StockId, StockDef),
  activityLevels: z.array(ActivityLevel).min(2),
  defaultActivity: Id,
  /** Age from which the player may set their own activity level. */
  activityChoiceFromAge: z.number().int().nonnegative(),
})

const FactorDef = z.strictObject({
  id: Id,
  /** Wording when the factor counted against the outcome, if that differs. */
  whenAgainst: z.string().optional(),
  /**
   * How the factor reads in plain language. Causes of gradual change are noun phrases ("regular
   * exercise"); factors of discrete outcomes are clauses ("it was flu season").
   */
  phrase: z.string().min(1),
  /** Alternative wording when the cause pushed something upward. */
  whenRising: z.string().optional(),
  visibility: z.enum(['evident', 'inferable', 'hidden']).default('evident'),
})
export type FactorDef = z.infer<typeof FactorDef>

const PacingDef = z.strictObject({
  /** Cap on optional decisions opened in any twelve months, by life stage. */
  maxOptionalDecisionsPerYear: z.record(Id, z.number().int().nonnegative()),
})

const LifeTable = z.strictObject({
  source: z.string().min(1),
  asOf: z.number().int(),
  /** Annual probability of death at each whole age from 0. */
  male: z.array(z.number().min(0).max(1)).min(50),
  female: z.array(z.number().min(0).max(1)).min(50),
  /**
   * The published table ends in an open interval ("100 and older") with only a life expectancy.
   * Beyond the last listed age the engine uses a constant annual probability chosen to reproduce
   * that expectancy, and nobody lives past maxAge.
   */
  openIntervalLifeExpectancy: z.strictObject({ male: z.number().positive(), female: z.number().positive() }),
  maxAge: z.number().int().positive(),
})
export type LifeTable = z.infer<typeof LifeTable>

const CountryDef = z.strictObject({
  id: Id,
  name: z.string(),
  demonym: z.string(),
  currency: z.string(),
  /** The year new characters are born. */
  startYear: z.number().int(),
  /** Boys born per girl born. */
  sexRatioAtBirth: z.strictObject({ value: z.number().positive(), source: z.string(), asOf: z.number() }),
  lifeTable: LifeTable,
  names: z.strictObject({
    source: z.string(),
    male: z.array(z.string()).min(5),
    female: z.array(z.string()).min(5),
    family: z.array(z.string()).min(5),
  }),
  states: z.array(StateDef).min(1),
  family: FamilyDef,
  people: PeopleDef,
  economy: EconomyDef,
  labor: LaborDef,
  tax: TaxDef,
  money: MoneyDef,
  education: EducationDef,
  norms: NormsDef,
  schools: SchoolNamesDef,
})
export type CountryDef = z.infer<typeof CountryDef>

export const ContentBundle = z.strictObject({
  schemaVersion: z.literal(1),
  hash: z.string(),
  stages: z.array(StageDef).min(1),
  body: BodyDef,
  descriptors: z.array(DescriptorDef),
  factors: z.array(FactorDef),
  pacing: PacingDef,
  events: z.array(EventDef),
  processes: z.array(ProcessDef),
  text: z.array(TextDef),
  country: CountryDef,
})
export type ContentBundle = z.infer<typeof ContentBundle>
/** The bundle as written in data files, before defaults are filled in. */
export type ContentBundleInput = z.input<typeof ContentBundle>

/** Schemas for individual files, used by the compiler to give precise error locations. */
export const FileSchemas = {
  stages: z.array(StageDef),
  body: BodyDef,
  descriptors: z.array(DescriptorDef),
  factors: z.array(FactorDef),
  pacing: PacingDef,
  events: z.array(EventDef),
  processes: z.array(ProcessDef),
  text: z.array(TextDef),
  country: CountryDef.omit({ lifeTable: true, names: true, states: true, family: true, people: true, economy: true, labor: true, tax: true, money: true, education: true, norms: true, schools: true }),
  family: FamilyDef,
  people: PeopleDef,
  economy: EconomyDef,
  labor: LaborDef.omit({ occupations: true }),
  occupations: LaborDef.shape.occupations,
  tax: TaxDef,
  money: MoneyDef,
  education: EducationDef,
  norms: NormsDef,
  schools: SchoolNamesDef,
  lifeTableMeta: LifeTable.omit({ male: true, female: true }),
  names: CountryDef.shape.names,
}
