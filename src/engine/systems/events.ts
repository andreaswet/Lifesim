/**
 * Event selection (design §9.3).
 *
 * Each month, for each living person: take the events indexed for their life stage, test
 * preconditions, draw hazards, apply the interrupt governor, then fire.
 */

import { evalBool, evalNumber, renderTemplate, type Env } from '../core/expr'
import { dexp } from '../core/dmath'
import { ageInYears } from '../core/time'
import { applyEffects, emitFact, evalFactData, type Ctx } from '../context'
import type { CHazard } from '../content/prepare'
import { newId, type GameState, type OutcomeRecord, type Person } from '../state'
import { makeEnv } from '../views'
import { hasOpenDecision, openDecision } from './decisions'

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
    if (event.decision && hasOpenDecision(state, `event:${event.id}`, person)) continue

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
    if (event.decision) {
      openDecision(ctx, {
        source: `event:${event.id}`,
        subject: person,
        class: event.decision.class,
        deadlineMonths: event.decision.deadlineMonths,
        promptId: event.decision.prompt,
        options: event.decision.options.map((o) => ({ id: o.id, label: renderTemplate(o.label, env), ...(o.cost ? { cost: o.cost } : {}) })),
        optional: event.optional,
        sourceClass: event.sourceClass,
      })
    }
  }
}
