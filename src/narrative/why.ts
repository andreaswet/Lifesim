/**
 * "Why?" (design §10.4). The answer is built from the stored OutcomeRecord: the base rate, then
 * the factors that moved the odds, largest first. Because the record is what the simulation
 * actually used to decide the outcome, the explanation cannot drift away from the mechanics.
 */

import { evalBool, renderTemplate } from '../engine/core/expr'
import { ageInYears } from '../engine/core/time'
import type { Prepared } from '../engine/content/prepare'
import type { GameState, Scalar } from '../engine/state'
import { makeEnv, numberWord } from '../engine/views'

export interface Explanation {
  /** What is being explained, as it appeared in the log. */
  subject: string
  lines: string[]
}

/** "one in twelve", "one in 250": a probability as a person would say it. */
export function oneIn(probability: number): string {
  if (probability <= 0) return 'a great many'
  const n = 1 / probability
  let rounded: number
  if (n < 20) rounded = Math.max(2, Math.round(n))
  else if (n < 100) rounded = Math.round(n / 5) * 5
  else if (n < 1000) rounded = Math.round(n / 10) * 10
  else if (n < 10000) rounded = Math.round(n / 100) * 100
  else rounded = Math.round(n / 1000) * 1000
  return rounded <= 12 ? numberWord(rounded) : rounded.toLocaleString('en-US')
}

export function explainOutcome(state: GameState, content: Prepared, outcomeId: string): Explanation | null {
  const outcome = state.outcomes[outcomeId]
  const subject = outcome ? state.people[outcome.subjectId] : undefined
  if (!outcome || !subject) return null
  const entry = state.log.find((e) => e.fact.outcomeId === outcomeId)
  const age = ageInYears(subject.born, outcome.month)

  // The first matching variant is used: an explanation should read the same every time it is asked.
  const say = (id: string, data: Record<string, Scalar>): string | null => {
    const text = content.textById.get(id)
    if (!text) return null
    const env = makeEnv(state, content, subject, { fact: data })
    const variant = text.variants.find((v) => !v.when || evalBool(v.when, env))
    return variant ? renderTemplate(variant.text, env) : null
  }

  const male = subject.sex === 'male'
  const base: Record<string, Scalar> = {
    oneIn: oneIn(outcome.base),
    age,
    person: age < 18 ? (male ? 'boy' : 'girl') : male ? 'man' : 'woman',
    child: male ? 'boy' : 'girl',
  }
  const lines: string[] = []
  const first = say(`why.${outcome.kind}`, base) ?? say('why.base', base)
  if (first) lines.push(first)

  let hidden = false
  const factors = [...outcome.factors].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
  for (const factor of factors) {
    const def = content.factors.get(factor.id)
    if (!def) continue
    if (def.visibility === 'hidden') {
      hidden = true
      continue
    }
    const line = say(factor.contribution > 0 ? 'why.more' : 'why.less', { phrase: def.phrase })
    if (line) lines.push(line)
  }
  if (hidden) {
    const line = say('why.hidden', {})
    if (line) lines.push(line)
  }
  if (outcome.kind === 'death' && outcome.factors.length === 0) {
    const line = say('why.death_table_only', {})
    if (line) lines.push(line)
  }
  return { subject: entry?.text ?? '', lines }
}
