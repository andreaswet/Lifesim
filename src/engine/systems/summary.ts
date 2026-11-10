/**
 * The year summary (design §10.3). On the last month of each year of life the engine gathers what
 * changed and the main reason from the cause ledger, and emits it as one fact. Wording is the
 * narrator's job.
 */

import { ageInYears, yearOf } from '../core/time'
import { emitFact, type Ctx } from '../context'
import type { Person } from '../state'

/** Net change in a stock over a year below which the character would not notice. */
const NOTICEABLE = 0.012

export function yearSummary(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  if ((state.now + 1 - person.born) % 12 !== 0) return
  const age = ageInYears(person.born, state.now)

  const causes = state.ledger[person.id]?.[String(age)]?.cardio ?? {}
  let net = 0
  for (const cause in causes) net += causes[cause]!
  let mainCause: string | null = null
  let mainSize = 0
  for (const cause in causes) {
    const v = causes[cause]!
    // The main cause is the largest one pulling in the direction things actually went.
    if (Math.sign(v) === Math.sign(net) && Math.abs(v) > mainSize) {
      mainSize = Math.abs(v)
      mainCause = cause
    }
  }
  const trend = net > NOTICEABLE ? 'up' : net < -NOTICEABLE ? 'down' : 'flat'

  let significant = 0
  let illnesses = 0
  let choices = 0
  // The one event of the year most worth recalling. Milestone 1 takes the earliest significant
  // one (the loop runs backwards, so the last assignment wins); Milestone 6 scores salience
  // against the character's values (design §10.3).
  let highlight: string | null = null
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!
    if (entry.month <= state.now - 12) break
    if (entry.hidden || entry.fact.subjectId !== person.id) continue
    if (entry.fact.significant) {
      significant++
      const d = entry.fact.data
      const detail = d.which ?? d.direction ?? null
      highlight = detail === null ? entry.fact.kind : `${entry.fact.kind}:${detail}`
    }
    if (entry.fact.kind === 'illness_started') illnesses++
    if (entry.fact.kind === 'decision_opened') choices++
  }

  emitFact(
    ctx,
    {
      kind: 'year_summary',
      subject: person,
      data: { age, year: yearOf(state.now), stage: content.stageFor(age), trend, cause: mainCause, illnesses, choices, quiet: significant === 0 && choices === 0, highlight },
    },
    { sourceClass: 'system' },
  )
}
