/**
 * Word bands with hysteresis (design §11.1). Hidden numbers reach the player as wording, and the
 * wording only changes once a value has moved clearly past a boundary, so it does not flicker.
 * A change of band is itself a fact: it is how slow change becomes noticeable.
 */

import { ageInYears } from '../core/time'
import { emitFact, type Ctx } from '../context'
import type { Prepared } from '../content/prepare'
import type { DescriptorDef } from '../content/schema'
import type { GameState, Person } from '../state'
import { fitnessRatio } from '../views'

/** Age at which the body is measured against the adult peak rather than against its own age. */
const GROWN_AGE = 25

/** The hidden value behind each descriptor the engine knows how to compute. */
export const DESCRIPTOR_VALUES: Record<string, (state: GameState, content: Prepared, person: Person) => number> = {
  /** Cardio fitness relative to what the age allows: "fit for your age". */
  fitness: (state, content, person) => fitnessRatio(content, person, state.now),
  /**
   * What the body can actually do. For adults this is absolute cardio fitness, so it erodes with
   * age. A child is judged against what a child's body allows, or every toddler would read as frail.
   */
  stamina: (state, content, person) => {
    const age = (state.now - person.born) / 12
    return age < GROWN_AGE ? person.body.cardio / content.envelope('cardio', age) : person.body.cardio / content.envelope('cardio', GROWN_AGE)
  },
  strength: (state, content, person) => {
    const envelope = content.envelope('strength', (state.now - person.born) / 12)
    return envelope > 0 ? person.body.strength / envelope : 0
  },
}


export function bandFor(descriptor: DescriptorDef, value: number, currentId?: string): string {
  const bands = descriptor.bands
  const raw = (): number => {
    for (let i = 0; i < bands.length; i++) {
      const upTo = bands[i]!.upTo
      if (upTo === undefined || value < upTo) return i
    }
    return bands.length - 1
  }
  const current = currentId === undefined ? -1 : bands.findIndex((b) => b.id === currentId)
  if (current < 0) return bands[raw()]!.id
  const lower = current > 0 ? bands[current - 1]!.upTo : undefined
  const upper = bands[current]!.upTo
  const stays = (lower === undefined || value >= lower - descriptor.margin) && (upper === undefined || value < upper + descriptor.margin)
  return stays ? bands[current]!.id : bands[raw()]!.id
}

export function updatePerception(ctx: Ctx, person: Person): void {
  const { state, content } = ctx
  const seen = (state.perception[person.id] ??= {})
  for (const descriptor of content.descriptors.values()) {
    const valueOf = DESCRIPTOR_VALUES[descriptor.id]
    if (!valueOf) continue
    const previous = seen[descriptor.id]
    const band = bandFor(descriptor, valueOf(state, content, person), previous)
    if (band === previous) continue
    seen[descriptor.id] = band
    if (previous === undefined) continue
    if (descriptor.notableFromAge === undefined || ageInYears(person.born, state.now) < descriptor.notableFromAge) continue
    const order = descriptor.bands.map((b) => b.id)
    emitFact(
      ctx,
      {
        kind: 'band_changed',
        subject: person,
        data: { descriptor: descriptor.id, from: previous, to: band, direction: order.indexOf(band) > order.indexOf(previous) ? 'up' : 'down' },
        significant: true,
      },
      { sourceClass: 'player' },
    )
  }
}

export function describe(state: GameState, content: Prepared, person: Person, descriptorId: string): string {
  const descriptor = content.descriptors.get(descriptorId)
  const valueOf = DESCRIPTOR_VALUES[descriptorId]
  if (!descriptor || !valueOf) return ''
  const id = bandFor(descriptor, valueOf(state, content, person), state.perception[person.id]?.[descriptorId])
  return descriptor.bands.find((b) => b.id === id)?.text ?? ''
}
