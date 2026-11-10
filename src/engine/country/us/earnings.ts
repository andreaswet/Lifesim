/**
 * Milestone 2 stand-in for the labor market: parents have earnings that follow their schooling
 * and age, and can lose and find work. Everything here is replaced by occupations, employers and
 * the economy in Milestone 3.
 */

import { dexp, interpolate } from '../../core/dmath'
import type { Ctx } from '../../context'
import { ageYears } from '../../people'
import type { Person } from '../../state'

type Work = NonNullable<Person['work']>

export function initialWork(ctx: Ctx, person: Person, role: 'mother' | 'father'): Work {
  const cfg = ctx.content.bundle.country.earnings
  const { rng } = ctx
  // A person's place in the earnings distribution for their schooling, fixed for life.
  const base = cfg.medianFullTime.byEducation[person.education.level] * cfg.bySex[person.sex] * dexp(cfg.logSd * rng.normal('work.level', person.id))
  const working = rng.chance(role === 'father' ? cfg.employment.fathers : cfg.employment.mothers, 'work.participates', person.id)
  const partTime = working && role === 'mother' && rng.chance(cfg.employment.mothersPartTime, 'work.partTime', person.id)
  return { earnings: Math.round(base), hours: !working ? 'none' : partTime ? 'part' : 'full', employed: working, unemployedSince: null }
}

/** Yearly income this person brings in right now. */
export function currentIncome(ctx: Pick<Ctx, 'state' | 'content'>, person: Person): number {
  const work = person.work
  if (!work || person.died) return 0
  const cfg = ctx.content.bundle.country.earnings
  const age = ageYears(person, ctx.state.now)
  const full = work.earnings * interpolate(cfg.ageProfile.curve, age)
  if (age >= cfg.retirement.age) return work.hours === 'none' ? 0 : full * cfg.retirement.incomeShare
  if (work.hours === 'none') return 0
  const scaled = work.hours === 'part' ? full * cfg.employment.partTimeEarnings : full
  if (work.employed) return scaled
  const out = work.unemployedSince === null ? Infinity : ctx.state.now - work.unemployedSince
  return out < cfg.unemployment.months ? scaled * cfg.unemployment.incomeShare : 0
}

export type WorkChange = 'lost' | 'found' | null

/** One month of the job market for one adult. */
export function workMonth(ctx: Ctx, person: Person): WorkChange {
  const work = person.work
  if (!work || work.hours === 'none') return null
  const cfg = ctx.content.bundle.country.earnings
  if (ageYears(person, ctx.state.now) >= cfg.retirement.age) return null
  if (work.employed) {
    if (!ctx.rng.chance(cfg.jobLossPerMonth.byEducation[person.education.level], 'work.loss', person.id, ctx.state.now)) return null
    work.employed = false
    work.unemployedSince = ctx.state.now
    return 'lost'
  }
  if (!ctx.rng.chance(cfg.jobFindPerMonth, 'work.find', person.id, ctx.state.now)) return null
  work.employed = true
  work.unemployedSince = null
  return 'found'
}
