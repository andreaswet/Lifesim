/**
 * The narrator: turns facts into prose using the text templates in the content bundle
 * (design §10). It reads state but never changes it, and draws only from its own random stream,
 * so wording can change without changing a life.
 */

import { evalBool, renderTemplate, type Env } from '../engine/core/expr'
import type { KeyedRng } from '../engine/core/rng'
import { ageInYears, monthName, yearOf } from '../engine/core/time'
import type { Narration, Narrator } from '../engine/context'
import type { CText, Prepared } from '../engine/content/prepare'
import type { Fact, GameState, Person, Scalar } from '../engine/state'
import { makeEnv } from '../engine/views'

/** Months within which a variant that was just used is avoided when others are equally fresh. */
const RECENT_MONTHS = 60

interface Picked {
  text: string
  key: string
}

/**
 * Chooses among the variants whose conditions hold (design §10.2):
 *  1. fallback variants are considered only if nothing else matches;
 *  2. of the rest, only those used least often in this life stay in, so every eligible variant is
 *     used once before any is used twice;
 *  3. among those, variants with a condition are more specific and are preferred, and one used
 *     recently is avoided.
 */
function pick(texts: readonly CText[], env: Env, state: GameState, rng: KeyedRng, salt: string, subjectId: string): Picked | null {
  interface Candidate {
    text: CText
    index: number
    key: string
    uses: number
    fallback: boolean
    weight: number
  }
  let candidates: Candidate[] = []
  for (const text of texts) {
    if (!evalBool(text.when, env)) continue
    text.variants.forEach((variant, index) => {
      if (variant.when && !evalBool(variant.when, env)) return
      const key = `${text.id}#${index}`
      const last = state.narration.lastUsed[key]
      const recent = last !== undefined && state.now - last < RECENT_MONTHS
      candidates.push({ text, index, key, uses: state.narration.counts[key] ?? 0, fallback: variant.fallback, weight: variant.weight * (variant.when ? 3 : 1) * (recent ? 0.05 : 1) })
    })
  }
  if (candidates.some((c) => !c.fallback)) candidates = candidates.filter((c) => !c.fallback)
  if (candidates.length === 0) return null
  const fewest = Math.min(...candidates.map((c) => c.uses))
  candidates = candidates.filter((c) => c.uses === fewest)
  const chosen = candidates[Math.max(0, rng.weighted(candidates.map((c) => c.weight), 'text', salt, subjectId, state.now, state.log.length))]!
  return { text: renderTemplate(chosen.text.variants[chosen.index]!.text, env), key: chosen.key }
}

function byId(content: Prepared, id: string): CText[] {
  const text = content.textById.get(id)
  return text ? [text] : []
}

function pronouns(person: Person): Record<string, string> {
  return person.sex === 'male' ? { He: 'He', he: 'he', his: 'his', him: 'him', himself: 'himself' } : { He: 'She', he: 'she', his: 'her', him: 'her', himself: 'herself' }
}

/** The activity level that carried the most of this person's adult years, from the cause ledger. */
function mainActivity(state: GameState, person: Person): string | null {
  const years = state.ledger[person.id] ?? {}
  const tally: Record<string, number> = {}
  for (const age in years) {
    if (Number(age) < 18) continue
    const causes = years[age]?.cardio ?? {}
    let best: string | null = null
    let size = 0
    for (const cause in causes) {
      if (cause.startsWith('activity.') && Math.abs(causes[cause]!) >= size) {
        size = Math.abs(causes[cause]!)
        best = cause.slice('activity.'.length)
      }
    }
    if (best) tally[best] = (tally[best] ?? 0) + 1
  }
  let result: string | null = null
  for (const level in tally) if (result === null || tally[level]! > tally[result]!) result = level
  return result
}

function join(parts: Array<Picked | null>): Narration | null {
  const kept = parts.filter((p): p is Picked => p !== null)
  if (kept.length === 0) return null
  return { text: kept.map((p) => p.text).join(' '), variants: kept.map((p) => p.key) }
}

function yearSummary(fact: Fact, subject: Person, state: GameState, content: Prepared, rng: KeyedRng): Narration | null {
  const d = fact.data
  const factor = typeof d.cause === 'string' ? content.factors.get(d.cause) : undefined
  const phrase = factor ? (d.trend === 'up' && factor.whenRising ? factor.whenRising : factor.phrase) : ''
  const env = makeEnv(state, content, subject, { fact: { ...d, phrase } })
  const one = (id: string): Picked | null => pick(byId(content, id), env, state, rng, id, subject.id)

  const sentences: Array<Picked | null> = []
  if (d.highlight !== null) sentences.push(one('summary.highlight'))
  if (d.trend === 'up' && d.cause === 'growing') sentences.push(one('summary.growing'))
  else if (d.trend === 'up') sentences.push(one('summary.trend_up'))
  else if (d.trend === 'down') sentences.push(one('summary.trend_down'))
  if (typeof d.illnesses === 'number' && d.illnesses > 0) sentences.push(one('summary.illness'))
  if (!sentences.some((s) => s !== null)) sentences.push(one('summary.quiet'))

  const body = join(sentences)
  const header = d.age === 0 ? 'Your first year.' : `Age ${d.age}.`
  return body ? { text: `${header} ${body.text}`, variants: body.variants } : { text: header, variants: [] }
}

function obituary(fact: Fact, subject: Person, state: GameState, content: Prepared, rng: KeyedRng): Narration | null {
  const age = ageInYears(subject.born, state.now)
  const data: Record<string, Scalar> = {
    ...fact.data,
    ...pronouns(subject),
    bornMonth: monthName(subject.born),
    bornYear: yearOf(subject.born),
    diedMonth: monthName(state.now),
    diedYear: yearOf(state.now),
    mainActivity: mainActivity(state, subject),
  }
  const env = makeEnv(state, content, subject, { fact: data })
  const parts: Array<Picked | null> = [pick(byId(content, 'obituary.opening'), env, state, rng, 'obituary.opening', subject.id)]
  // Thirty is roughly where a life has enough adult years for a habit to describe it.
  if (age >= 30) parts.push(pick(byId(content, 'obituary.activity'), env, state, rng, 'obituary.activity', subject.id))
  return join(parts)
}

export function createNarrator(): Narrator {
  return {
    narrate(fact, state, content, rng) {
      const subject = state.people[fact.subjectId]
      if (!subject) return null
      if (fact.kind === 'year_summary') return yearSummary(fact, subject, state, content, rng)
      if (fact.kind === 'obituary') return obituary(fact, subject, state, content, rng)
      const texts = content.textByFact.get(fact.kind)
      if (!texts) return null
      const env = makeEnv(state, content, subject, { fact: fact.data })
      return join([pick(texts, env, state, rng, fact.kind, subject.id)])
    },
    byId(textId, subject, data, state, content, rng) {
      const env = makeEnv(state, content, subject, { fact: data })
      return join([pick(byId(content, textId), env, state, rng, textId, subject.id)])
    },
  }
}
