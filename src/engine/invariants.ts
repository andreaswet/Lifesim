/**
 * Invariants (design §14): things that must be true of every state. Tests and the batch tool run
 * these throughout a life. Later milestones add to the list (money sums to zero across accounts;
 * no parent is younger than their child).
 */

import type { Prepared } from './content/prepare'
import { STOCK_IDS } from './content/schema'
import type { GameState } from './state'

export function checkInvariants(state: GameState, content: Prepared): string[] {
  const problems: string[] = []
  const fail = (message: string): void => {
    problems.push(message)
  }

  if (!Number.isInteger(state.now)) fail('now is not a whole month')
  const self = state.people[state.playerId]
  if (!self) fail('player is missing from people')
  if (self && (state.phase === 'ended') !== Boolean(self.died)) fail('phase and player death disagree')

  for (const person of Object.values(state.people)) {
    const end = person.died?.at ?? state.now
    if (person.born > state.now) fail(`${person.id} is not born yet`)
    if (person.died && (person.died.at < person.born || person.died.at > state.now)) fail(`${person.id} died outside their own lifetime`)
    if ((end - person.born) / 12 > content.bundle.country.lifeTable.maxAge + 1) fail(`${person.id} is older than the maximum age`)
    for (const stock of STOCK_IDS) {
      const v = person.body[stock]
      if (!(v >= 0 && v <= 1)) fail(`${person.id} ${stock} is out of range: ${v}`)
    }
    if (!content.activityIndex.has(person.policies.activity)) fail(`${person.id} has unknown activity '${person.policies.activity}'`)
    if (person.died && !state.outcomes[person.died.outcomeId]) fail(`${person.id} died with no recorded outcome`)
  }

  for (const proc of Object.values(state.processes)) {
    const subject = state.people[proc.subjectId]
    if (!subject) fail(`process ${proc.id} has no subject`)
    else if (subject.died) fail(`process ${proc.id} belongs to someone who has died`)
    const def = content.processes.get(proc.def)
    if (!def) fail(`process ${proc.id} has unknown definition '${proc.def}'`)
    else if (!def.stageById.has(proc.stage)) fail(`process ${proc.id} is in unknown stage '${proc.stage}'`)
    if (proc.stageEnds <= proc.stageEntered) fail(`process ${proc.id} has a stage with no duration`)
  }

  for (const decision of state.decisions) {
    const subject = state.people[decision.subjectId]
    if (!subject) fail(`decision ${decision.id} has no subject`)
    else if (subject.died) fail(`decision ${decision.id} is open for someone who has died`)
    const spec = content.eventById.get(decision.eventId)?.decision
    if (!spec) fail(`decision ${decision.id} refers to an event with no decision`)
    else if (decision.options.some((o) => !spec.options.some((s) => s.id === o.id))) fail(`decision ${decision.id} has an option its event does not define`)
    if (decision.deadline !== null && decision.deadline < decision.opened) fail(`decision ${decision.id} was due before it opened`)
  }

  const ids = new Set<string>()
  let previous = -Infinity
  for (const entry of state.log) {
    if (ids.has(entry.id)) fail(`log id ${entry.id} is used twice`)
    ids.add(entry.id)
    if (entry.month < previous) fail(`log entry ${entry.id} is out of order`)
    previous = entry.month
    if (entry.month > state.now) fail(`log entry ${entry.id} is in the future`)
    // The dead do nothing: nothing may be logged for someone after the month they died.
    const subject = state.people[entry.fact.subjectId]
    if (!subject) fail(`log entry ${entry.id} is about nobody`)
    else if (subject.died && entry.month > subject.died.at) fail(`log entry ${entry.id} happened to ${subject.id} after their death`)
  }

  for (const outcome of Object.values(state.outcomes)) {
    if (!(outcome.probability >= 0 && outcome.probability <= 1)) fail(`outcome ${outcome.id} has probability ${outcome.probability}`)
    if (!state.people[outcome.subjectId]) fail(`outcome ${outcome.id} has no subject`)
  }

  return problems
}
