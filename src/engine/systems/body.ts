/**
 * Body stocks (design §3.1, §7.3). Milestone 1 models cardio fitness and strength.
 *
 * Each month has two steps, kept separate so the cause ledger can tell them apart:
 *  1. Growing and aging: capacity scales with the age envelope, whatever the person does.
 *  2. Behavior: the stock moves part of the way toward the level the current activity sustains.
 */

import { approach } from '../core/dmath'
import { adjustStock, type Ctx } from '../context'
import { STOCK_IDS } from '../content/schema'
import type { Person } from '../state'

export function updateBody(ctx: Ctx, person: Person): void {
  const { content, state } = ctx
  const body = content.bundle.body
  const months = state.now - person.born
  const level = body.activityLevels[content.activityIndex.get(person.policies.activity) ?? 0]!

  for (const stock of STOCK_IDS) {
    const def = body.stocks[stock]
    if (!def) continue
    const before = content.envelope(stock, months / 12)
    const after = content.envelope(stock, (months + 1) / 12)
    if (before > 0 && after !== before) {
      const scaled = person.body[stock] * (after / before)
      adjustStock(ctx, person, stock, scaled - person.body[stock], after > before ? 'growing' : 'aging')
    }
    const target = after * (level.sustains[stock] ?? 0)
    const moved = approach(person.body[stock], target, def.tauUpMonths, def.tauDownMonths)
    adjustStock(ctx, person, stock, moved - person.body[stock], `activity.${level.id}`)
  }
}
