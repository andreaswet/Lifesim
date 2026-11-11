/**
 * The year summary (design §10.3). On the last month of each year of life the engine gathers what
 * changed and the main reason from the cause ledger, and emits it as one fact. Wording is the
 * narrator's job.
 */

import { ageInYears, yearOf } from '../core/time'
import { emitFact, type Ctx } from '../context'
import type { Person } from '../state'
import { netWorth } from './money'

/**
 * How much each kind of event matters when one has to stand for the year. Milestone 6 replaces
 * this fixed order with salience scored against the character's values (design §10.3).
 */
const WEIGHT: Record<string, number> = {
  family_death: 10,
  parents_separated: 9,
  degree_earned: 9,
  hs_graduated: 8,
  school_left: 8,
  college_left: 8,
  college_started: 7,
  home_lost: 9,
  job_lost: 8,
  home_bought: 8,
  retired: 8,
  program_finished: 8,
  hired: 7,
  promoted: 7,
  inheritance: 7,
  moved: 6,
  job_quit: 6,
  hardship: 6,
  program_started: 6,
  housing_behind: 5,
  benefit_claimed: 5,
  student_loans_paid: 5,
  home_sold: 5,
  mortgage_denied: 4,
  review: 4,
  student_loans_due: 3,
  sibling_born: 6,
  admission: 5,
  college_chosen: 5,
  parent_job_lost: 5,
  equivalency: 5,
  school_started: 4,
  school_moved_up: 4,
  test_score: 4,
  probation: 4,
  milestone: 3,
  choice: 2,
  band_changed: 2,
}

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
  // The one event of the year most worth recalling: the weightiest, and the earliest of equals
  // (the loop runs backwards, so a later assignment is an earlier event).
  let highlight: string | null = null
  let highlightWeight = 0
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!
    if (entry.month <= state.now - 12) break
    if (entry.hidden || entry.fact.subjectId !== person.id) continue
    if (entry.fact.significant) {
      significant++
      const weight = WEIGHT[entry.fact.kind] ?? 1
      if (weight >= highlightWeight) {
        const d = entry.fact.data
        const detail = d.which ?? d.direction ?? null
        highlight = detail === null ? entry.fact.kind : `${entry.fact.kind}:${detail}`
        highlightWeight = weight
      }
    }
    if (entry.fact.kind === 'illness_started') illnesses++
    if (entry.fact.kind === 'decision_opened') choices++
  }

  // What the year did to the character's money, once it is theirs: in start-year dollars, so that
  // rising prices alone do not read as getting richer.
  let worth: 'up' | 'down' | 'flat' | null = null
  const now = netWorth(state, person.id) / state.world.priceLevel
  if (person.money && age >= 18) {
    const before = typeof person.flags['money.worth'] === 'number' ? (person.flags['money.worth'] as number) : null
    if (before !== null) {
      const change = now - before
      const matters = Math.max(1500, 0.08 * Math.abs(before))
      worth = change > matters ? 'up' : change < -matters ? 'down' : 'flat'
    }
    person.flags['money.worth'] = Math.round(now)
  }

  emitFact(
    ctx,
    {
      kind: 'year_summary',
      subject: person,
      data: { age, year: yearOf(state.now), stage: content.stageFor(age), trend, cause: mainCause, illnesses, choices, quiet: significant === 0 && choices === 0, highlight, worth, worthNow: Math.round(now * state.world.priceLevel) },
    },
    { sourceClass: 'system' },
  )
}
