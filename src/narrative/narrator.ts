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
import { siblingsOf } from '../engine/people'
import { makeEnv } from '../engine/views'

/** Months after which a used variant is as welcome again as any other. */
const RECENT_MONTHS = 96

interface Picked {
  text: string
  key: string
}

/**
 * Chooses among the variants whose conditions hold (design §10.2):
 *  1. fallback variants are considered only if nothing else matches;
 *  2. of the rest, only those used least often in this life stay in, so every eligible variant is
 *     used once before any is used twice;
 *  3. among those, variants with a condition are more specific and are preferred, and the more
 *     recently one was used the less likely it is.
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
      // The longer ago a variant was last used, the more welcome it is: squared, so that one used
      // last year is almost never chosen over one used five years ago.
      const last = state.narration.lastUsed[key]
      const rest = last === undefined ? 1 : Math.min(1, (state.now - last) / RECENT_MONTHS)
      candidates.push({ text, index, key, uses: state.narration.counts[key] ?? 0, fallback: variant.fallback, weight: variant.weight * (variant.when ? 3 : 1) * Math.max(0.001, rest * rest) })
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

/** "a", "a and b", "a, b and c". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The lines after the birth: who the parents are, who else is in the house, how they live. */
function familyIntro(fact: Fact, subject: Person, state: GameState, content: Prepared, rng: KeyedRng): Narration | null {
  const older = siblingsOf(state, subject).filter((s) => s.born < subject.born && !s.died)
  const items: string[] = []
  const keys: string[] = []
  for (const sibling of older) {
    const env = makeEnv(state, content, subject, { fact: { who: sibling.id } })
    const item = pick(byId(content, 'family.intro.sibling_item'), env, state, rng, `family.intro.sibling_item:${sibling.id}`, subject.id)
    if (item) {
      items.push(item.text)
      keys.push(item.key)
    }
  }
  const only = older.length === 1 ? older[0]! : null
  const data: Record<string, Scalar> = { ...fact.data, count: older.length, list: joinList(items), word: only ? (only.sex === 'male' ? 'brother' : 'sister') : '' }
  const env = makeEnv(state, content, subject, { fact: data })
  const parts = ['family.intro.parents', 'family.intro.siblings', 'family.intro.work'].map((id) => pick(byId(content, id), env, state, rng, id, subject.id))
  const joined = join(parts)
  return joined ? { text: joined.text, variants: [...joined.variants, ...keys] } : null
}

/** A passage from the years before memory: who looks after you, and what the house is like. */
function earlyChapter(fact: Fact, subject: Person, state: GameState, content: Prepared, rng: KeyedRng): Narration | null {
  const env = makeEnv(state, content, subject, { fact: fact.data })
  return join(['early.care', 'early.home'].map((id) => pick(byId(content, id), env, state, rng, id, subject.id)))
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
  if (d.worth === 'up' || d.worth === 'down') sentences.push(one('summary.worth'))
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
    siblings: siblingsOf(state, subject).length,
    level: subject.education.level,
    schooled: subject.education.status !== 'not_modeled',
  }
  const env = makeEnv(state, content, subject, { fact: data })
  const one = (id: string): Picked | null => pick(byId(content, id), env, state, rng, id, subject.id)
  const parts: Array<Picked | null> = [one('obituary.opening'), one('obituary.family')]
  if (age >= 25) parts.push(one('obituary.school'))
  if (age >= 25) parts.push(one('obituary.work'))
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
      if (fact.kind === 'family_intro') return familyIntro(fact, subject, state, content, rng)
      if (fact.kind === 'early_chapter') return earlyChapter(fact, subject, state, content, rng)
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
