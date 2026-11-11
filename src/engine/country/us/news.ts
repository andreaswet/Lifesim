/** News of the family reaching the player (replaced by news that travels through contact in Milestone 4). */

import { emitFact, type Ctx } from '../../context'
import { relationOf } from '../../people'
import { player, type Person, type Scalar } from '../../state'

/** Tells the player about something that happened to someone in their family. */
export function tellPlayer(ctx: Ctx, kind: string, who: Person, data: Record<string, Scalar> = {}, significant = true): void {
  const self = player(ctx.state)
  if (self.died || who.id === self.id) return
  const relation = relationOf(self, who)
  if (relation === 'other') return
  emitFact(ctx, { kind, subject: self, data: { who: who.id, relation, ...data }, significant }, { sourceClass: 'npc' })
}
