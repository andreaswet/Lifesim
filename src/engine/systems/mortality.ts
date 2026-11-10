/**
 * Mortality (design §7.3). In Milestone 1 the only input is the life table: the monthly chance of
 * death depends on age and sex and nothing else. Milestone 5 replaces this with cause-specific
 * hazards normalized so the population still reproduces the same table.
 */

import { monthlyFromAnnual } from '../content/prepare'
import { rulesFor } from '../country'
import { ageInYears } from '../core/time'
import { emitFact, type Ctx } from '../context'
import { newId, type OutcomeRecord, type Person } from '../state'

export function die(ctx: Ctx, person: Person, cause: string, outcome: OutcomeRecord): void {
  const { state } = ctx
  state.outcomes[outcome.id] = outcome
  person.died = { at: state.now, cause, outcomeId: outcome.id }

  // The dead do nothing: their processes stop and their open decisions close.
  for (const id of Object.keys(state.processes)) {
    if (state.processes[id]!.subjectId === person.id) delete state.processes[id]
  }
  state.decisions = state.decisions.filter((d) => d.subjectId !== person.id)
  rulesFor(ctx.content.bundle.country.id).afterDeath(ctx, person)

  const age = ageInYears(person.born, state.now)
  emitFact(ctx, { kind: 'death', subject: person, data: { age, cause }, significant: true, outcomeId: outcome.id }, { sourceClass: 'chance' })
  if (person.id === state.playerId) {
    emitFact(ctx, { kind: 'obituary', subject: person, data: { age, cause }, significant: true }, { sourceClass: 'system' })
    state.phase = 'ended'
    ctx.interrupted = true
  }
}

export function mortalityTick(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  const age = ageInYears(person.born, state.now)
  if (person.id === state.playerId && age < state.meta.options.protectPlayerUntilAge) return

  const annual = content.annualMortality(person.sex, age)
  const monthly = monthlyFromAnnual(annual)
  if (!ctx.rng.chance(monthly, 'mortality', person.id, state.now)) return

  die(ctx, person, 'unspecified', {
    id: newId(state, 'out'),
    month: state.now,
    kind: 'death',
    subjectId: person.id,
    model: 'hazard',
    base: annual,
    baseSource: content.bundle.country.lifeTable.source,
    factors: [],
    probability: monthly,
    context: { age, sex: person.sex },
  })
}
