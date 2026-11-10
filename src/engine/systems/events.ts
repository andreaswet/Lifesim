/**
 * Event selection (design §9.3) and decisions (design §5.3).
 *
 * Each month, for each living person: take the events indexed for their life stage, test
 * preconditions, draw hazards, apply the interrupt governor, then fire.
 */

import { evalBool, evalNumber, renderTemplate, type Env } from '../core/expr'
import { dexp } from '../core/dmath'
import { ageInYears } from '../core/time'
import { applyEffects, emitFact, evalFactData, recordNarration, type Ctx, type Narration } from '../context'
import type { CDecision, CEvent, CHazard, Prepared } from '../content/prepare'
import { newId, type Decision, type GameState, type OutcomeRecord, type Person } from '../state'
import type { KeyedRng } from '../core/rng'
import { makeEnv } from '../views'

export interface HazardEvaluation {
  monthly: number
  factors: Array<{ id: string; contribution: number }>
}

/** The named-factor hazard model of design §3.2. */
export function evaluateHazard(hazard: CHazard, env: Env): HazardEvaluation {
  const factors: HazardEvaluation['factors'] = []
  let logMultiplier = 0
  for (const f of hazard.factors) {
    if (f.when && !evalBool(f.when, env)) continue
    const contribution = f.beta * evalNumber(f.value, env)
    if (contribution === 0) continue
    factors.push({ id: f.id, contribution })
    logMultiplier += contribution
  }
  const ratePerYear = (hazard.basePerYear * dexp(logMultiplier)) / hazard.normalization
  return { monthly: 1 - dexp(-ratePerYear / 12), factors }
}

/** Optional decisions opened for this person in the last twelve months. */
function recentOptionalDecisions(state: GameState, person: Person): number {
  let count = 0
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!
    if (entry.month <= state.now - 12) break
    if (entry.fact.kind === 'decision_opened' && entry.fact.subjectId === person.id && entry.fact.data.optional === true) count++
  }
  return count
}

export function chooseAutomatically(state: GameState, content: Prepared, rng: KeyedRng, decision: Decision): string {
  const event = content.eventById.get(decision.eventId)
  const subject = state.people[decision.subjectId]
  if (!event?.decision || !subject) throw new Error(`Decision '${decision.id}' no longer matches content`)
  const env = makeEnv(state, content, subject)
  const weights = event.decision.options.map((o) => Math.max(0, evalNumber(o.autoWeight, env)))
  let index = rng.weighted(weights, 'decision.auto', decision.id)
  if (index < 0) index = 0
  return event.decision.options[index]!.id
}

export function resolveDecision(ctx: Ctx, decision: Decision, optionId: string, lapsed: boolean): void {
  const { state, content } = ctx
  const event = content.eventById.get(decision.eventId)
  const subject = state.people[decision.subjectId]
  const option = event?.decision?.options.find((o) => o.id === optionId)
  if (!event || !subject || !option) throw new Error(`Decision '${decision.id}' has no option '${optionId}'`)

  state.decisions = state.decisions.filter((d) => d.id !== decision.id)
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

function openDecision(ctx: Ctx, event: CEvent, spec: CDecision, subject: Person): void {
  const { state, content } = ctx
  const env = makeEnv(state, content, subject)
  const decision: Decision = {
    id: newId(state, 'dec'),
    eventId: event.id,
    subjectId: subject.id,
    class: spec.class,
    opened: state.now,
    deadline: spec.class === 'blocking' ? null : state.now + spec.deadlineMonths,
    prompt: '',
    options: spec.options.map((o) => ({ id: o.id, label: renderTemplate(o.label, env) })),
  }

  if (subject.id !== state.playerId) {
    // Other people decide for themselves at once. (Their policy arrives in Milestone 4.)
    state.decisions.push(decision)
    resolveDecision(ctx, decision, chooseAutomatically(state, content, ctx.rng, decision), false)
    return
  }

  const narration: Narration | null = ctx.narrator?.byId(spec.prompt, subject, {}, state, content, ctx.rng) ?? null
  if (narration) recordNarration(state, narration)
  decision.prompt = narration?.text ?? ''
  state.decisions.push(decision)
  emitFact(ctx, { kind: 'decision_opened', subject, data: { event: event.id, decision: decision.id, optional: event.optional } }, { sourceClass: event.sourceClass, narration })
  ctx.interrupted = true
}

export function lapseDecisions(ctx: Ctx): void {
  const { state, content } = ctx
  for (const decision of [...state.decisions]) {
    if (decision.deadline === null || state.now <= decision.deadline) continue
    resolveDecision(ctx, decision, chooseAutomatically(state, content, ctx.rng, decision), true)
  }
}

export function runEvents(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  const stage = content.stageFor(ageInYears(person.born, state.now))
  const candidates = content.eventsByStage.get(stage) ?? []
  const cap = content.bundle.pacing.maxOptionalDecisionsPerYear[stage]

  for (const event of candidates) {
    if (person.died) return
    const history = person.eventHistory[event.id]
    if (history) {
      if (event.once) continue
      if (event.cooldownMonths > 0 && state.now - history.last < event.cooldownMonths) continue
    }
    if (event.decision && state.decisions.some((d) => d.eventId === event.id && d.subjectId === person.id)) continue

    const env = makeEnv(state, content, person)
    if (!evalBool(event.when, env)) continue

    let outcome: OutcomeRecord | null = null
    if (event.hazard) {
      const evaluation = evaluateHazard(event.hazard, env)
      if (!ctx.rng.chance(evaluation.monthly, 'event', event.id, person.id, state.now)) continue
      outcome = {
        id: newId(state, 'out'),
        month: state.now,
        kind: event.id,
        subjectId: person.id,
        model: 'hazard',
        base: event.hazard.basePerYear,
        baseSource: event.hazard.source,
        factors: evaluation.factors,
        probability: evaluation.monthly,
        context: {},
      }
    }

    // The governor holds back optional offers in a crowded year. It runs after the draw so that
    // holding one back never changes any other draw.
    if (event.optional && event.decision && cap !== undefined && recentOptionalDecisions(state, person) >= cap) continue

    person.eventHistory[event.id] = { last: state.now, count: (history?.count ?? 0) + 1 }
    if (outcome) state.outcomes[outcome.id] = outcome
    applyEffects(ctx, event.effects, person, {}, event.sourceClass)
    if (event.fact) {
      emitFact(
        ctx,
        { kind: event.fact.kind, subject: person, data: evalFactData(event.fact, env), significant: event.fact.significant, ...(outcome ? { outcomeId: outcome.id } : {}) },
        { sourceClass: event.sourceClass },
      )
    }
    if (event.decision) openDecision(ctx, event, event.decision, person)
  }
}
