/**
 * The engine's public functions: create a life, apply a command (design §4.2).
 *
 * `step` is a pure function of (state, command) given the content: it clones the state once,
 * applies the command and returns the new state with what happened. Nothing here touches the DOM,
 * the clock or Math.random.
 */

import { KeyedRng } from './core/rng'
import { monthIndex, monthName, yearOf } from './core/time'
import { emitFact, type Ctx, type Narrator } from './context'
import type { Prepared } from './content/prepare'
import { Command, ENGINE_VERSION, SCHEMA_VERSION, StartOptions, livingPeople, player, type Decision, type Fact, type GameState, type Person } from './state'
import { updateBody } from './systems/body'
import { chooseAutomatically, lapseDecisions, resolveDecision, runEvents } from './systems/events'
import { mortalityTick } from './systems/mortality'
import { updatePerception } from './systems/perception'
import { runProcesses } from './systems/processes'
import { yearSummary } from './systems/summary'
import { ageInYears } from './core/time'

export class EngineError extends Error {}

export interface EngineEnv {
  content: Prepared
  /** Omit to run without prose (faster; used by some batch runs). */
  narrator?: Narrator | null
  /** Throw if the same random key is drawn twice in one month. On in tests. */
  detectDuplicateDraws?: boolean
  /** Change the given state in place instead of cloning it. For batch runs only. */
  mutate?: boolean
}

export interface StepResult {
  state: GameState
  /** Structured record of what happened during this step, in order. */
  facts: Fact[]
  /** Decisions waiting for the player. */
  pending: Decision[]
}

function makeCtx(state: GameState, env: EngineEnv): Ctx {
  return {
    state,
    content: env.content,
    rng: new KeyedRng(state.meta.seed, { detectDuplicates: env.detectDuplicateDraws ?? false }),
    narrator: env.narrator ?? null,
    facts: [],
    interrupted: false,
  }
}

/**
 * One month (design §5.2). Each phase runs for everyone before the next begins, so nobody acts on
 * information from later in the same month. Phases for systems that do not exist yet (economy,
 * work, money, relationships) will slot in at their documented positions.
 */
export function tick(ctx: Ctx): void {
  const { state } = ctx
  ctx.rng.beginTick()

  lapseDecisions(ctx) //          2. schedule: deadlines that have passed
  runProcesses(ctx) //            2. processes
  for (const p of livingPeople(state)) updateBody(ctx, p) //     3–4. routine realized; body
  for (const p of livingPeople(state)) mortalityTick(ctx, p) //  7. health hazards
  if (state.phase === 'ended') return // the month in which the player died is not finished
  for (const p of livingPeople(state)) runEvents(ctx, p) //      10. event selection
  const self = player(state)
  updatePerception(ctx, self) //  11. appraisal: what the character notices
  yearSummary(ctx, self) //       12. roll-up

  state.now += 1
}

export function createLife(options: { seed: string; start?: Partial<StartOptions> }, env: EngineEnv): GameState {
  const { content } = env
  const country = content.bundle.country
  const start = StartOptions.parse(options.start ?? {})
  const rng = new KeyedRng(options.seed)

  const ratio = country.sexRatioAtBirth.value
  const sex = start.sex ?? (rng.chance(ratio / (1 + ratio), 'birth.sex') ? 'male' : 'female')
  const born = monthIndex(country.startYear, rng.int(12, 'birth.month'))
  const self: Person = {
    id: 'p1',
    name: {
      first: start.firstName?.trim() || rng.pick(country.names[sex], 'birth.firstName'),
      family: start.familyName?.trim() || rng.pick(country.names.family, 'birth.familyName'),
    },
    sex,
    born,
    birthDay: rng.range(1, 28, 'birth.day'),
    body: { cardio: content.bundle.body.stocks.cardio!.atBirth, strength: content.bundle.body.stocks.strength!.atBirth },
    policies: { activity: content.bundle.body.defaultActivity },
    flags: {},
    eventHistory: {},
  }

  const state: GameState = {
    meta: { schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, contentHash: content.bundle.hash, seed: options.seed, options: start, commandLog: [] },
    now: born,
    phase: 'alive',
    playerId: self.id,
    lineage: [],
    people: { [self.id]: self },
    processes: {},
    decisions: [],
    log: [],
    outcomes: {},
    ledger: {},
    perception: {},
    narration: { lastUsed: {}, counts: {} },
    nextId: 1,
  }
  const ctx = makeCtx(state, env)
  emitFact(ctx, { kind: 'birth', subject: self, data: { month: monthName(born), year: yearOf(born), day: self.birthDay, sex }, significant: true }, { sourceClass: 'system' })
  return state
}

function advance(ctx: Ctx, until: 'month' | 'season' | 'birthday'): void {
  const { state } = ctx
  if (state.decisions.some((d) => d.class === 'blocking' && d.subjectId === state.playerId)) return
  const self = player(state)
  const limit = until === 'month' ? 1 : until === 'season' ? 3 : 12
  for (let i = 0; i < limit; i++) {
    tick(ctx)
    if (state.phase === 'ended' || ctx.interrupted) return
    if (until === 'birthday' && (state.now - self.born) % 12 === 0) return
  }
}

export function step(input: GameState, commandInput: Command, env: EngineEnv): StepResult {
  const command = Command.parse(commandInput)
  const state = env.mutate ? input : structuredClone(input)
  const ctx = makeCtx(state, env)

  if (state.phase === 'ended') return { state, facts: [], pending: [] }
  if (state.meta.contentHash !== env.content.bundle.hash) {
    // Loading under newer content is supported; exact replay is not promised across versions.
    state.meta.contentHash = env.content.bundle.hash
  }
  state.meta.commandLog.push(command)

  switch (command.type) {
    case 'advance':
      advance(ctx, command.until)
      break
    case 'decide': {
      const decision = state.decisions.find((d) => d.id === command.decisionId && d.subjectId === state.playerId)
      if (!decision) throw new EngineError(`There is no open decision '${command.decisionId}'`)
      if (!decision.options.some((o) => o.id === command.optionId)) throw new EngineError(`Decision '${decision.id}' has no option '${command.optionId}'`)
      resolveDecision(ctx, decision, command.optionId, false)
      break
    }
    case 'setPolicy': {
      const self = player(state)
      const activity = command.policy.activity
      if (activity !== undefined && activity !== self.policies.activity) {
        const body = env.content.bundle.body
        if (!env.content.activityIndex.has(activity)) throw new EngineError(`Unknown activity level '${activity}'`)
        if (ageInYears(self.born, state.now) < body.activityChoiceFromAge) throw new EngineError('Too young to choose an activity level')
        const from = self.policies.activity
        self.policies.activity = activity
        emitFact(ctx, { kind: 'activity_changed', subject: self, data: { from, to: activity, direction: env.content.activityIndex.get(activity)! > (env.content.activityIndex.get(from) ?? 0) ? 'up' : 'down' } }, { sourceClass: 'player' })
      }
      break
    }
  }

  return { state, facts: ctx.facts, pending: state.decisions.filter((d) => d.subjectId === state.playerId) }
}

/** What the character would choose if left to decide; used by AI players. */
export function autoChoice(state: GameState, decision: Decision, env: EngineEnv): string {
  return chooseAutomatically(state, env.content, new KeyedRng(state.meta.seed), decision)
}

/**
 * Rebuilds a life from its seed, start options and command log (design §4.3). With the same
 * engine version and content, the result is identical to the original state.
 */
export function replay(source: { seed: string; options: Partial<StartOptions>; commands: Command[] }, env: EngineEnv): GameState {
  let state = createLife({ seed: source.seed, start: source.options }, env)
  for (const command of source.commands) state = step(state, command, { ...env, mutate: true }).state
  return state
}
