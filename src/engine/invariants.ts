/**
 * Invariants (design §14): things that must be true of every state. Tests and the batch tool run
 * these throughout a life. Later milestones add to the list (money sums to zero across accounts;
 * no parent is younger than their child).
 */

import type { Prepared } from './content/prepare'
import { STOCK_IDS } from './content/schema'
import type { GameState } from './state'
import { systemDecisionExists } from './systems/decisions'

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

  for (const person of Object.values(state.people)) {
    // No parent is younger than their child, or anywhere near it.
    for (const parentId of [person.motherId, person.fatherId]) {
      if (parentId === null) continue
      const parent = state.people[parentId]
      if (!parent) fail(`${person.id} has a parent who does not exist`)
      else if (person.born - parent.born < 13 * 12) fail(`${parentId} was under 13 when ${person.id} was born`)
    }
    if (person.died) {
      if (person.householdId !== null) fail(`${person.id} has died but still belongs to a household`)
      if (person.partner !== null) fail(`${person.id} has died but still has a partner`)
    } else {
      const home = person.householdId ? state.households[person.householdId] : undefined
      if (!home) fail(`${person.id} has no household`)
      else if (!home.members.includes(person.id)) fail(`${person.id} is not listed in their own household`)
      if (person.partner) {
        const other = state.people[person.partner.id]
        if (!other || other.partner?.id !== person.id) fail(`${person.id}'s partnership is one-sided`)
        else if (other.died) fail(`${person.id} is partnered with someone who has died`)
      }
    }
    const edu = person.education
    if ((edu.status === 'k12') !== (edu.grade !== null)) fail(`${person.id} school status and grade disagree`)
    if ((edu.status === 'college') !== (edu.college !== null)) fail(`${person.id} college status and record disagree`)
    if (edu.loans < 0 || !(person.strain >= 0 && person.strain <= 1) || !(edu.disengagement >= 0 && edu.disengagement <= 1)) fail(`${person.id} has an out-of-range school value`)
    for (const skill in person.skills) if (!(person.skills[skill]! > -6 && person.skills[skill]! < 40)) fail(`${person.id} skill ${skill} is out of range`)
  }
  for (const home of Object.values(state.households)) {
    const seen = new Set<string>()
    for (const id of home.members) {
      if (seen.has(id)) fail(`household ${home.id} lists ${id} twice`)
      seen.add(id)
      const member = state.people[id]
      if (!member) fail(`household ${home.id} has a member who does not exist`)
      else if (member.householdId !== home.id) fail(`household ${home.id} lists ${id}, who lives elsewhere`)
    }
    if (!(home.income >= 0)) fail(`household ${home.id} has negative income`)
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
    if (decision.source.startsWith('event:')) {
      const spec = content.eventById.get(decision.source.slice(6))?.decision
      if (!spec) fail(`decision ${decision.id} refers to an event with no decision`)
      else if (decision.options.some((o) => !spec.options.some((s) => s.id === o.id))) fail(`decision ${decision.id} has an option its event does not define`)
    } else if (!decision.source.startsWith('system:') || !systemDecisionExists(decision.source.slice(7))) {
      fail(`decision ${decision.id} has an unknown source '${decision.source}'`)
    }
    if (decision.options.length < 2) fail(`decision ${decision.id} offers no real choice`)
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
