/**
 * The process runner (design §3.3, §9.2). A process is an instance of a data-defined state
 * machine attached to a person. Each month, for each active process:
 *   1. apply the stage's monthly effects and show its signals;
 *   2. test its transitions;
 *   3. if none fired and the stage's duration has run out, move to its `next` stage.
 */

import { evalBool, evalNumber } from '../core/expr'
import { applyEffects, emitFact, evalFactData, type Ctx, type SourceClass } from '../context'
import type { CProcess } from '../content/prepare'
import type { Person, ProcessInstance } from '../state'
import { makeEnv } from '../views'

// Process content does not yet declare its own source class; chance-started illness is all
// Milestone 1 has. This becomes a field on the process definition when processes diversify.
const PROCESS_SOURCE: SourceClass = 'chance'

function moveTo(ctx: Ctx, def: CProcess, instance: ProcessInstance, subject: Person, to: string): void {
  const { state } = ctx
  const from = def.stageById.get(instance.stage)!
  applyEffects(ctx, from.onExit, subject, { process: instance }, PROCESS_SOURCE)
  if (to === 'end') {
    delete state.processes[instance.id]
    return
  }
  const next = def.stageById.get(to)
  if (!next) throw new Error(`Process '${def.id}' has no stage '${to}'`)
  instance.stage = next.id
  instance.stageEntered = state.now
  instance.stageEnds = state.now + ctx.rng.range(next.duration[0], next.duration[1], 'process.duration', def.id, subject.id, state.now, next.id)
  applyEffects(ctx, next.onEnter, subject, { process: instance }, PROCESS_SOURCE)
}

export function runProcesses(ctx: Ctx): void {
  const { state, content } = ctx
  for (const id of Object.keys(state.processes).sort()) {
    const instance = state.processes[id]
    if (!instance) continue // ended by an earlier process this month
    const subject = state.people[instance.subjectId]
    if (!subject || subject.died) {
      delete state.processes[id]
      continue
    }
    const def = content.processes.get(instance.def)
    if (!def) throw new Error(`Unknown process '${instance.def}'`)
    const stage = def.stageById.get(instance.stage)!

    // An instance is first handled the month after it was created or changed stage, so a stage
    // of N months applies its monthly effects exactly N times before its duration runs out.
    applyEffects(ctx, stage.monthly, subject, { process: instance }, PROCESS_SOURCE)

    for (const signal of stage.signals) {
      if (signal.monthlyChance < 1 && !ctx.rng.chance(signal.monthlyChance, 'process.signal', instance.id, signal.id, state.now)) continue
      const env = makeEnv(state, content, subject, { process: instance })
      const noticed = evalBool(signal.notice, env)
      emitFact(ctx, { kind: signal.fact.kind, subject, data: evalFactData(signal.fact, env), significant: signal.fact.significant }, { sourceClass: PROCESS_SOURCE, hidden: !noticed })
    }

    let moved = false
    for (const transition of stage.transitions) {
      const env = makeEnv(state, content, subject, { process: instance })
      if (transition.when && !evalBool(transition.when, env)) continue
      if (transition.hazard) {
        const p = evalNumber(transition.hazard, env)
        if (!ctx.rng.chance(p, 'process.transition', instance.id, stage.id, transition.to, state.now)) continue
      }
      moveTo(ctx, def, instance, subject, transition.to)
      moved = true
      break
    }
    if (!moved && state.now >= instance.stageEnds) moveTo(ctx, def, instance, subject, stage.next)
  }
}
