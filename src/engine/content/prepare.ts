/**
 * Turns a validated content bundle into the form the engine runs on: expressions parsed, lookups
 * indexed. Nothing here adds meaning; it only avoids re-parsing strings every month.
 */

import { compileExpr, compileTemplate, type Expr, type Template } from '../core/expr'
import { dlog, dpow, interpolate } from '../core/dmath'
import type { ContentBundle, DecisionSpec, DescriptorDef, Effect, EventDef, FactSpec, FactorDef, Hazard, ProcessDef, StockId, TextDef } from './schema'

export interface CFact {
  kind: string
  data: Array<[string, Expr]>
  significant: boolean
}

export type CEffect =
  | { t: 'adjust'; stock: StockId; delta: Expr; cause: string }
  | { t: 'setPolicy'; activity: string }
  | { t: 'setFlag'; name: string; value: Expr }
  | { t: 'startProcess'; def: string }
  | { t: 'emit'; fact: CFact }

export interface CHazard {
  basePerYear: number
  source: string
  normalization: number
  factors: Array<{ id: string; value: Expr; when: Expr | null; beta: number }>
}

export interface COption {
  id: string
  label: Template
  cost: NonNullable<DecisionSpec['options'][number]['cost']> | null
  effects: CEffect[]
  fact: CFact | null
  autoWeight: Expr
}

export interface CDecision {
  class: 'blocking' | 'deferrable'
  deadlineMonths: number
  prompt: string
  options: COption[]
}

export interface CEvent {
  id: string
  sourceClass: EventDef['sourceClass']
  stages: string[] | null
  when: Expr
  once: boolean
  cooldownMonths: number
  hazard: CHazard | null
  optional: boolean
  effects: CEffect[]
  fact: CFact | null
  decision: CDecision | null
}

export interface CStage {
  id: string
  status: string | null
  duration: [number, number]
  onEnter: CEffect[]
  monthly: CEffect[]
  onExit: CEffect[]
  signals: Array<{ id: string; notice: Expr; monthlyChance: number; fact: CFact }>
  transitions: Array<{ to: string; when: Expr | null; hazard: Expr | null }>
  next: string
}

export interface CProcess {
  id: string
  stages: CStage[]
  stageById: Map<string, CStage>
}

export interface CText {
  id: string
  fact: string | null
  when: Expr
  variants: Array<{ when: Expr | null; weight: number; fallback: boolean; text: Template }>
}

export interface Prepared {
  bundle: ContentBundle
  events: CEvent[]
  eventById: Map<string, CEvent>
  /** Events that can apply in each life stage, in file order. */
  eventsByStage: Map<string, CEvent[]>
  processes: Map<string, CProcess>
  text: CText[]
  textById: Map<string, CText>
  textByFact: Map<string, CText[]>
  descriptors: Map<string, DescriptorDef>
  factors: Map<string, FactorDef>
  activityIndex: Map<string, number>
  /** Life stage id for an age in whole years. */
  stageFor(age: number): string
  /** Annual probability of death from the life table, including the open-interval rule. */
  annualMortality(sex: 'male' | 'female', age: number): number
  /** Age envelope of a stock at an age in (fractional) years. */
  envelope(stock: StockId, ageYears: number): number
}

function cFact(f: FactSpec): CFact {
  return { kind: f.kind, data: Object.entries(f.data).map(([k, v]) => [k, compileExpr(v)]), significant: f.significant }
}

function cEffect(e: Effect): CEffect {
  if ('adjust' in e) return { t: 'adjust', stock: e.adjust.stock, delta: compileExpr(e.adjust.delta), cause: e.adjust.cause }
  if ('setPolicy' in e) return { t: 'setPolicy', activity: e.setPolicy.activity }
  if ('setFlag' in e) return { t: 'setFlag', name: e.setFlag.name, value: compileExpr(e.setFlag.value) }
  if ('startProcess' in e) return { t: 'startProcess', def: e.startProcess }
  return { t: 'emit', fact: cFact(e.emit) }
}

function cHazard(h: Hazard): CHazard {
  return {
    basePerYear: h.base.perYear,
    source: h.base.source,
    normalization: h.normalization,
    factors: h.factors.map((f) => ({ id: f.id, value: compileExpr(f.value), when: f.when === undefined ? null : compileExpr(f.when), beta: f.beta })),
  }
}

function cEvent(e: EventDef): CEvent {
  return {
    id: e.id,
    sourceClass: e.sourceClass,
    stages: e.stages ?? null,
    when: compileExpr(e.when),
    once: e.once,
    cooldownMonths: e.cooldownMonths,
    hazard: e.hazard ? cHazard(e.hazard) : null,
    optional: e.optional,
    effects: e.effects.map(cEffect),
    fact: e.fact ? cFact(e.fact) : null,
    decision: e.decision
      ? {
          class: e.decision.class,
          deadlineMonths: e.decision.deadlineMonths,
          prompt: e.decision.prompt,
          options: e.decision.options.map((o) => ({
            id: o.id,
            label: compileTemplate(o.label),
            cost: o.cost ?? null,
            effects: o.effects.map(cEffect),
            fact: o.fact ? cFact(o.fact) : null,
            autoWeight: compileExpr(o.autoWeight),
          })),
        }
      : null,
  }
}

function cProcess(p: ProcessDef): CProcess {
  const stages: CStage[] = p.stages.map((s) => ({
    id: s.id,
    status: s.status ?? null,
    duration: s.duration.months,
    onEnter: s.onEnter.map(cEffect),
    monthly: s.monthly.map(cEffect),
    onExit: s.onExit.map(cEffect),
    signals: s.signals.map((g) => ({ id: g.id, notice: compileExpr(g.notice), monthlyChance: g.monthlyChance, fact: cFact(g.fact) })),
    transitions: s.transitions.map((t) => ({ to: t.to, when: t.when === undefined ? null : compileExpr(t.when), hazard: t.hazard === undefined ? null : compileExpr(t.hazard) })),
    next: s.next,
  }))
  return { id: p.id, stages, stageById: new Map(stages.map((s) => [s.id, s])) }
}

function cText(t: TextDef): CText {
  return {
    id: t.id,
    fact: t.fact ?? null,
    when: compileExpr(t.when),
    variants: t.variants.map((v) => ({ when: v.when === undefined ? null : compileExpr(v.when), weight: v.weight, fallback: v.fallback, text: compileTemplate(v.text.trim()) })),
  }
}

const preparedCache = new WeakMap<ContentBundle, Prepared>()

export function prepareContent(bundle: ContentBundle): Prepared {
  const cached = preparedCache.get(bundle)
  if (cached) return cached

  const events = bundle.events.map(cEvent)
  const stagesAscending = [...bundle.stages].sort((a, b) => a.fromAge - b.fromAge)
  const eventsByStage = new Map<string, CEvent[]>()
  for (const s of stagesAscending) eventsByStage.set(s.id, events.filter((e) => !e.stages || e.stages.includes(s.id)))

  const text = bundle.text.map(cText)
  const textByFact = new Map<string, CText[]>()
  for (const t of text) {
    if (!t.fact) continue
    const list = textByFact.get(t.fact) ?? []
    list.push(t)
    textByFact.set(t.fact, list)
  }

  const table = bundle.country.lifeTable
  const openQ = {
    // With a constant annual probability q, expected remaining life is about 1/q - 1/2.
    male: Math.min(1, 1 / (table.openIntervalLifeExpectancy.male + 0.5)),
    female: Math.min(1, 1 / (table.openIntervalLifeExpectancy.female + 0.5)),
  }

  const prepared: Prepared = {
    bundle,
    events,
    eventById: new Map(events.map((e) => [e.id, e])),
    eventsByStage,
    processes: new Map(bundle.processes.map((p) => [p.id, cProcess(p)])),
    text,
    textById: new Map(text.map((t) => [t.id, t])),
    textByFact,
    descriptors: new Map(bundle.descriptors.map((d) => [d.id, d])),
    factors: new Map(bundle.factors.map((f) => [f.id, f])),
    activityIndex: new Map(bundle.body.activityLevels.map((a, i) => [a.id, i])),
    stageFor(age) {
      let id = stagesAscending[0]!.id
      for (const s of stagesAscending) if (age >= s.fromAge) id = s.id
      return id
    },
    annualMortality(sex, age) {
      if (age >= table.maxAge) return 1
      const row = table[sex]
      return age < row.length ? row[age]! : openQ[sex]
    },
    envelope(stock, ageYears) {
      return interpolate(bundle.body.stocks[stock]!.envelope, ageYears)
    },
  }
  preparedCache.set(bundle, prepared)
  return prepared
}

/** Monthly probability equivalent to an annual probability, assuming a constant hazard in the year. */
export function monthlyFromAnnual(q: number): number {
  if (q >= 1) return 1
  if (q <= 0) return 0
  return 1 - dpow(1 - q, 1 / 12)
}

/** Monthly probability from an annual rate (events per person-year). */
export function monthlyFromRate(ratePerYear: number): number {
  return 1 - dpow(2.718281828459045, -ratePerYear / 12)
}

/** Annual rate equivalent to an annual probability. */
export function rateFromAnnual(q: number): number {
  return q >= 1 ? Infinity : -dlog(1 - q)
}
