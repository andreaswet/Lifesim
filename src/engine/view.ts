/**
 * The perceived world (design §3.5, §11). The interface receives a PlayerView and nothing else:
 * hidden numbers leave the engine only as words, as observed behavior, or as the kind of record a
 * real person would hold. Imperfect information is enforced here, at the boundary.
 */

import { ageInYears, monthName, yearOf } from './core/time'
import type { Prepared } from './content/prepare'
import { player, type GameState } from './state'
import { describe } from './systems/perception'

export interface FeedItem {
  id: string
  kind: string
  dateText: string
  age: number
  text: string
  significant: boolean
  /** Present when the player can ask why this happened. */
  whyId?: string
  /** Present while this entry is a decision still waiting for an answer. */
  decisionId?: string
}

export interface DecisionView {
  id: string
  blocking: boolean
  prompt: string
  /** e.g. "Decide by March 2061", or empty for blocking decisions. */
  dueText: string
  options: Array<{ id: string; label: string; costs: string[] }>
}

export interface PlayerView {
  phase: 'alive' | 'ended'
  seed: string
  date: { month: string; year: number }
  person: { name: string; firstName: string; sex: 'male' | 'female'; age: number; ageText: string; stageLabel: string }
  status: { health: string; conditions: string[]; fitness: string; strength: string }
  feed: FeedItem[]
  decisions: DecisionView[]
  routine: {
    activity: {
      current: string
      canChange: boolean
      lockedReason: string
      options: Array<{ id: string; label: string; description: string; hoursPerWeek: number }>
    }
  }
  advance: { allowed: boolean; blockedReason: string }
  death: { age: number; dateText: string } | null
}

function ageText(months: number): string {
  if (months < 1) return 'newborn'
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} old`
  return `${Math.floor(months / 12)} years old`
}

function costText(cost: { hoursPerWeek?: number | undefined; money?: number | undefined; energy?: string | undefined } | null, currency: string): string[] {
  if (!cost) return []
  const out: string[] = []
  if (cost.hoursPerWeek) out.push(`${cost.hoursPerWeek} hour${cost.hoursPerWeek === 1 ? '' : 's'} a week`)
  if (cost.money) out.push(new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cost.money))
  if (cost.energy && cost.energy !== 'none') out.push(cost.energy === 'low' ? 'takes a little energy' : cost.energy === 'moderate' ? 'takes some energy' : 'takes a lot of energy')
  return out
}

export function perceive(state: GameState, content: Prepared): PlayerView {
  const self = player(state)
  const at = self.died?.at ?? state.now
  const months = at - self.born
  const age = ageInYears(self.born, at)
  const body = content.bundle.body
  const stage = content.bundle.stages.find((s) => s.id === content.stageFor(age))

  const openById = new Map(state.decisions.filter((d) => d.subjectId === self.id).map((d) => [d.id, d]))
  const feed: FeedItem[] = []
  for (const entry of state.log) {
    if (entry.hidden || !entry.text) continue
    const decisionId = entry.fact.kind === 'decision_opened' ? String(entry.fact.data.decision) : undefined
    feed.push({
      id: entry.id,
      kind: entry.fact.kind,
      dateText: `${monthName(entry.month)} ${yearOf(entry.month)}`,
      age: entry.age,
      text: entry.text,
      significant: entry.fact.significant,
      ...(entry.fact.outcomeId ? { whyId: entry.fact.outcomeId } : {}),
      ...(decisionId && openById.has(decisionId) ? { decisionId } : {}),
    })
  }

  const decisions: DecisionView[] = [...openById.values()].map((d) => {
    const spec = content.eventById.get(d.eventId)?.decision
    return {
      id: d.id,
      blocking: d.class === 'blocking',
      prompt: d.prompt,
      dueText: d.deadline === null ? '' : `Decide by the end of ${monthName(d.deadline)} ${yearOf(d.deadline)}`,
      options: d.options.map((o) => ({ id: o.id, label: o.label, costs: costText(spec?.options.find((s) => s.id === o.id)?.cost ?? null, content.bundle.country.currency) })),
    }
  })

  const conditions: string[] = []
  for (const id of Object.keys(state.processes).sort()) {
    const inst = state.processes[id]!
    if (inst.subjectId !== self.id) continue
    const status = content.processes.get(inst.def)?.stageById.get(inst.stage)?.status
    if (status) conditions.push(status)
  }

  const blocking = decisions.find((d) => d.blocking)
  const canChoose = age >= body.activityChoiceFromAge && state.phase === 'alive'

  return {
    phase: state.phase,
    seed: state.meta.seed,
    date: { month: monthName(at), year: yearOf(at) },
    person: { name: `${self.name.first} ${self.name.family}`, firstName: self.name.first, sex: self.sex, age, ageText: ageText(months), stageLabel: stage?.label ?? '' },
    status: {
      health: conditions[0] ?? describe(state, content, self, 'stamina'),
      conditions,
      fitness: describe(state, content, self, 'fitness'),
      strength: describe(state, content, self, 'strength'),
    },
    feed,
    decisions,
    routine: {
      activity: {
        current: self.policies.activity,
        canChange: canChoose,
        lockedReason: canChoose ? '' : state.phase === 'ended' ? '' : `You are too young to set your own routine. That changes at ${body.activityChoiceFromAge}.`,
        options: body.activityLevels.map((a) => ({ id: a.id, label: a.label, description: a.description, hoursPerWeek: a.hoursPerWeek })),
      },
    },
    advance: {
      allowed: state.phase === 'alive' && !blocking,
      blockedReason: state.phase === 'ended' ? 'This life has ended.' : blocking ? 'Something needs your answer first.' : '',
    },
    death: self.died ? { age, dateText: `${monthName(self.died.at)} ${yearOf(self.died.at)}` } : null,
  }
}
