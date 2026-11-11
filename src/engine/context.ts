/**
 * The working context of one `step`, and the two functions through which all state changes pass
 * (design §4.4): `adjustStock` for gradual change, which accumulates in the cause ledger, and
 * `emitFact`, which records what happened for the log and the narrator.
 */

import { evalExpr, evalNumber, type Env } from './core/expr'
import { clamp01 } from './core/dmath'
import type { KeyedRng } from './core/rng'
import { ageInYears } from './core/time'
import type { CEffect, CFact, Prepared } from './content/prepare'
import type { StockId } from './content/schema'
import { newId, type Fact, type GameState, type LifeLogEntry, type Person, type ProcessInstance, type Scalar } from './state'
import { runHook } from './systems/actions'
import { makeEnv, type EnvExtras } from './views'

export interface Narration {
  text: string
  /** Keys of the text variants used, as "templateId#variantIndex". */
  variants: string[]
}

/**
 * Turns facts into prose. Implemented outside the engine (src/narrative) and passed in, so the
 * simulation never depends on wording and can run with no narrator at all.
 */
export interface Narrator {
  narrate(fact: Fact, state: GameState, content: Prepared, rng: KeyedRng): Narration | null
  /** Renders a text fetched by id, such as a decision prompt. */
  byId(textId: string, subject: Person, data: Record<string, Scalar>, state: GameState, content: Prepared, rng: KeyedRng): Narration | null
}

export interface Ctx {
  state: GameState
  content: Prepared
  rng: KeyedRng
  narrator: Narrator | null
  /** Facts emitted during this step, in order. */
  facts: Fact[]
  /** Set when something happened that should stop a time skip. */
  interrupted: boolean
}

export type SourceClass = LifeLogEntry['sourceClass']

export function recordNarration(state: GameState, narration: Narration): void {
  for (const key of narration.variants) {
    state.narration.lastUsed[key] = state.now
    state.narration.counts[key] = (state.narration.counts[key] ?? 0) + 1
  }
}

export function emitFact(
  ctx: Ctx,
  spec: { kind: string; subject: Person; data?: Record<string, Scalar>; significant?: boolean; outcomeId?: string },
  options: { sourceClass: SourceClass; hidden?: boolean; narration?: Narration | null },
): Fact {
  const { state } = ctx
  const fact: Fact = {
    kind: spec.kind,
    subjectId: spec.subject.id,
    month: state.now,
    data: spec.data ?? {},
    significant: spec.significant ?? false,
    ...(spec.outcomeId ? { outcomeId: spec.outcomeId } : {}),
  }
  ctx.facts.push(fact)
  // Milestone 1 has only the player. From Milestone 4, facts about other people reach the log
  // only when news of them reaches the player.
  if (fact.subjectId !== state.playerId) return fact

  // A caller that has already produced the prose (a decision prompt) passes it in.
  const narration = options.narration !== undefined ? options.narration : (ctx.narrator?.narrate(fact, state, ctx.content, ctx.rng) ?? null)
  if (narration && options.narration === undefined) recordNarration(state, narration)
  state.log.push({
    id: newId(state, 'log'),
    month: state.now,
    age: ageInYears(spec.subject.born, state.now),
    fact,
    text: narration?.text ?? '',
    ...(narration && narration.variants[0] ? { templateId: narration.variants[0] } : {}),
    hidden: options.hidden ?? false,
    sourceClass: options.sourceClass,
  })
  return fact
}

/** Gradual change to a stock, attributed to a cause. Returns the change actually applied. */
export function adjustStock(ctx: Ctx, person: Person, stock: StockId, delta: number, cause: string): number {
  const before = person.body[stock]
  const after = clamp01(before + delta)
  const applied = after - before
  if (applied === 0) return 0
  person.body[stock] = after

  const ageKey = String(ageInYears(person.born, ctx.state.now))
  const byPerson = (ctx.state.ledger[person.id] ??= {})
  const byYear = (byPerson[ageKey] ??= {})
  const byStock = (byYear[stock] ??= {})
  byStock[cause] = (byStock[cause] ?? 0) + applied
  return applied
}

export function evalFactData(fact: CFact, env: Env): Record<string, Scalar> {
  const data: Record<string, Scalar> = {}
  for (const [key, expr] of fact.data) {
    const v = evalExpr(expr, env)
    data[key] = v === undefined || (typeof v === 'object' && v !== null) ? null : (v as Scalar)
  }
  return data
}

export function startProcess(ctx: Ctx, defId: string, subject: Person, sourceClass: SourceClass): ProcessInstance | null {
  const def = ctx.content.processes.get(defId)
  if (!def) throw new Error(`Unknown process '${defId}'`)
  const { state } = ctx
  // One instance of a given process per person at a time.
  for (const id in state.processes) {
    const existing = state.processes[id]!
    if (existing.subjectId === subject.id && existing.def === defId) return null
  }
  const first = def.stages[0]!
  const instance: ProcessInstance = {
    id: newId(state, 'proc'),
    def: defId,
    subjectId: subject.id,
    stage: first.id,
    started: state.now,
    stageEntered: state.now,
    stageEnds: state.now + ctx.rng.range(first.duration[0], first.duration[1], 'process.duration', defId, subject.id, state.now, first.id),
  }
  state.processes[instance.id] = instance
  applyEffects(ctx, first.onEnter, subject, { process: instance }, sourceClass)
  return instance
}

export function applyEffects(ctx: Ctx, effects: readonly CEffect[], subject: Person, extras: EnvExtras, sourceClass: SourceClass): void {
  for (const effect of effects) {
    // The environment is rebuilt for each effect so later effects see earlier ones.
    const env = makeEnv(ctx.state, ctx.content, subject, extras)
    switch (effect.t) {
      case 'adjust':
        adjustStock(ctx, subject, effect.stock, evalNumber(effect.delta, env), effect.cause)
        break
      case 'setPolicy':
        Object.assign(subject.policies, effect.policy)
        break
      case 'setFlag': {
        const v = evalExpr(effect.value, env)
        subject.flags[effect.name] = v === undefined || typeof v === 'object' ? null : (v as Scalar)
        break
      }
      case 'startProcess':
        startProcess(ctx, effect.def, subject, sourceClass)
        break
      case 'run':
        runHook(ctx, effect.hook, subject)
        break
      case 'emit':
        emitFact(ctx, { kind: effect.fact.kind, subject, data: evalFactData(effect.fact, env), significant: effect.fact.significant }, { sourceClass })
        break
    }
  }
}
