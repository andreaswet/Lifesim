/**
 * Decisions (design §5.3). A decision comes either from a content event, whose options and
 * effects are data, or from an engine system, which builds the options from the situation (the
 * colleges that admitted you) and resolves the choice in code. Both are stored, shown, answered
 * and left to lapse in the same way.
 */

import { evalBool, evalNumber, renderTemplate } from '../core/expr'
import type { KeyedRng } from '../core/rng'
import { applyEffects, emitFact, evalFactData, recordNarration, type Ctx, type Narration, type SourceClass } from '../context'
import type { Prepared } from '../content/prepare'
import { newId, type Cost, type Decision, type GameState, type Person, type Scalar } from '../state'
import { makeEnv } from '../views'

export interface SystemDecision {
  /** Applies the choice. `lapsed` is true when the deadline passed and the character chose. */
  resolve(ctx: Ctx, decision: Decision, subject: Person, optionId: string, lapsed: boolean): void
  /** Relative weights of the options when the character decides for themselves. */
  weights(state: GameState, content: Prepared, decision: Decision, subject: Person): number[]
}

const SYSTEMS: Record<string, SystemDecision> = {}

export function registerSystemDecision(id: string, handler: SystemDecision): void {
  SYSTEMS[id] = handler
}

export function systemDecisionExists(id: string): boolean {
  return id in SYSTEMS
}

function eventOf(content: Prepared, decision: Decision) {
  return decision.source.startsWith('event:') ? content.eventById.get(decision.source.slice(6)) : undefined
}

function systemOf(decision: Decision): SystemDecision | undefined {
  return decision.source.startsWith('system:') ? SYSTEMS[decision.source.slice(7)] : undefined
}

export function chooseAutomatically(state: GameState, content: Prepared, rng: KeyedRng, decision: Decision): string {
  const subject = state.people[decision.subjectId]
  if (!subject) throw new Error(`Decision '${decision.id}' has no subject`)
  let weights: number[]
  const system = systemOf(decision)
  if (system) {
    weights = system.weights(state, content, decision, subject)
  } else {
    const spec = eventOf(content, decision)?.decision
    if (!spec) throw new Error(`Decision '${decision.id}' no longer matches content`)
    const env = makeEnv(state, content, subject)
    weights = decision.options.map((o) => {
      const option = spec.options.find((s) => s.id === o.id)
      return option ? Math.max(0, evalNumber(option.autoWeight, env)) : 0
    })
  }
  // Keyed by subject and month as well as the decision, so the draw is distinct from any other.
  let index = rng.weighted(weights, 'decision.auto', decision.source, decision.subjectId, decision.opened)
  if (index < 0) index = 0
  return decision.options[index]!.id
}

export function resolveDecision(ctx: Ctx, decision: Decision, optionId: string, lapsed: boolean): void {
  const { state, content } = ctx
  const subject = state.people[decision.subjectId]
  if (!subject || !decision.options.some((o) => o.id === optionId)) throw new Error(`Decision '${decision.id}' has no option '${optionId}'`)
  state.decisions = state.decisions.filter((d) => d.id !== decision.id)

  const system = systemOf(decision)
  if (system) {
    system.resolve(ctx, decision, subject, optionId, lapsed)
    return
  }
  const event = eventOf(content, decision)
  const option = event?.decision?.options.find((o) => o.id === optionId)
  if (!event || !option) throw new Error(`Decision '${decision.id}' no longer matches content`)
  // A choice the player makes is theirs; one that lapses is the character acting in character.
  applyEffects(ctx, option.effects, subject, {}, 'player')
  const env = makeEnv(state, content, subject)
  const label = decision.options.find((o) => o.id === optionId)?.label ?? optionId
  if (option.fact) {
    emitFact(ctx, { kind: option.fact.kind, subject, data: { ...evalFactData(option.fact, env), lapsed }, significant: option.fact.significant }, { sourceClass: 'player' })
  } else {
    emitFact(ctx, { kind: 'decision_made', subject, data: { event: event.id, option: optionId, choice: label, lapsed } }, { sourceClass: 'player' })
  }
}

/** Renders a text by id without a narrator: the first variant whose condition holds. Used for labels. */
export function plainText(ctx: Ctx, textId: string, subject: Person, data: Record<string, Scalar> = {}): string {
  const text = ctx.content.textById.get(textId)
  if (!text) return ''
  const env = makeEnv(ctx.state, ctx.content, subject, { fact: data })
  const variant = text.variants.find((v) => !v.when || evalBool(v.when, env))
  return variant ? renderTemplate(variant.text, env) : ''
}

export interface DecisionRequest {
  source: string
  subject: Person
  class: 'blocking' | 'deferrable'
  deadlineMonths: number
  promptId: string
  promptData?: Record<string, Scalar>
  options: Array<{ id: string; label: string; cost?: Cost }>
  optional: boolean
  sourceClass: SourceClass
}

/**
 * Opens a decision. For the player it is stored, shown and stops the time skip. Anyone else
 * decides for themselves at once. (A fuller policy for other people arrives in Milestone 4.)
 */
export function openDecision(ctx: Ctx, request: DecisionRequest): void {
  const { state, content } = ctx
  const decision: Decision = {
    id: newId(state, 'dec'),
    source: request.source,
    subjectId: request.subject.id,
    class: request.class,
    opened: state.now,
    deadline: request.class === 'blocking' ? null : state.now + request.deadlineMonths,
    prompt: '',
    options: request.options,
    optional: request.optional,
  }
  if (request.subject.id !== state.playerId) {
    state.decisions.push(decision)
    resolveDecision(ctx, decision, chooseAutomatically(state, content, ctx.rng, decision), false)
    return
  }
  const narration: Narration | null = ctx.narrator?.byId(request.promptId, request.subject, request.promptData ?? {}, state, content, ctx.rng) ?? null
  if (narration) recordNarration(state, narration)
  decision.prompt = narration?.text ?? ''
  state.decisions.push(decision)
  emitFact(ctx, { kind: 'decision_opened', subject: request.subject, data: { source: request.source, decision: decision.id, optional: request.optional } }, { sourceClass: request.sourceClass, narration })
  ctx.interrupted = true
}

export function hasOpenDecision(state: GameState, source: string, subject: Person): boolean {
  return state.decisions.some((d) => d.source === source && d.subjectId === subject.id)
}

export function lapseDecisions(ctx: Ctx): void {
  const { state, content } = ctx
  for (const decision of [...state.decisions]) {
    if (decision.deadline === null || state.now <= decision.deadline) continue
    resolveDecision(ctx, decision, chooseAutomatically(state, content, ctx.rng, decision), true)
  }
}
