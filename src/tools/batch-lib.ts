/**
 * Headless batch simulation and its statistics (design §13). Kept free of file and console access
 * so tests can call it; `batch.ts` is the command-line wrapper.
 */

import { checkInvariants, createLife, type EngineEnv, type GameState, type Prepared } from '../engine'
import { monthlyFromAnnual } from '../engine/content/prepare'
import { player } from '../engine/state'
import { playYear, type Strategy } from './players'

export interface LifeResult {
  seed: string
  strategy: Strategy
  sex: 'male' | 'female'
  /** Age at death in years, to the middle of the month of death. */
  ageAtDeath: number
  simulatedYears: number
  fluCount: number
  decisionsOpened: Record<string, number>
  yearsInStage: Record<string, number>
  significantBySource: Record<string, number>
  /** Cardio stock at the 60th birthday, if reached. */
  cardioAt60: number | null
  activityAt60: string | null
  variantCounts: Record<string, number>
  feedLines: number
  invariantProblems: string[]
}

export function runLife(seed: string, strategy: Strategy, env: EngineEnv): LifeResult {
  const { content } = env
  // Batch lives are never protected in early childhood: the statistics must be honest.
  let state: GameState = createLife({ seed, start: { protectPlayerUntilAge: 0 } }, env)
  const self = (): ReturnType<typeof player> => player(state)
  const problems: string[] = []
  const yearsInStage: Record<string, number> = {}
  let cardioAt60: number | null = null
  let activityAt60: string | null = null
  let years = 0

  while (state.phase === 'alive') {
    const age = Math.floor((state.now - self().born) / 12)
    const stage = content.stageFor(age)
    yearsInStage[stage] = (yearsInStage[stage] ?? 0) + 1
    if (age === 60 && cardioAt60 === null) {
      cardioAt60 = self().body.cardio
      activityAt60 = self().policies.activity
    }
    state = playYear(state, strategy, { ...env, mutate: true })
    years++
    if (years % 10 === 0 || state.phase === 'ended') problems.push(...checkInvariants(state, content))
    if (years > 200) {
      problems.push('life did not end')
      break
    }
  }

  const person = self()
  const died = person.died?.at ?? state.now
  const decisionsOpened: Record<string, number> = {}
  const significantBySource: Record<string, number> = {}
  let fluCount = 0
  let feedLines = 0
  for (const entry of state.log) {
    if (entry.fact.kind === 'illness_started') fluCount++
    if (entry.fact.kind === 'decision_opened') {
      const stage = content.stageFor(entry.age)
      decisionsOpened[stage] = (decisionsOpened[stage] ?? 0) + 1
    }
    if (entry.fact.significant && !entry.hidden && entry.sourceClass !== 'system') {
      significantBySource[entry.sourceClass] = (significantBySource[entry.sourceClass] ?? 0) + 1
    }
    if (entry.text && !entry.hidden) feedLines++
  }

  return {
    seed,
    strategy,
    sex: person.sex,
    ageAtDeath: (died - person.born + 0.5) / 12,
    simulatedYears: (died - person.born) / 12,
    fluCount,
    decisionsOpened,
    yearsInStage,
    significantBySource,
    cardioAt60,
    activityAt60,
    variantCounts: { ...state.narration.counts },
    feedLines,
    invariantProblems: problems,
  }
}

export interface TableTargets {
  lifeExpectancy: number
  /** Probability of surviving from birth to each age. */
  survival: Record<number, number>
}

export const SURVIVAL_AGES = [1, 20, 40, 65, 85, 100]

/** What the life table itself implies, computed with the same monthly compounding the engine uses. */
export function tableTargets(content: Prepared, sex: 'male' | 'female'): TableTargets {
  const maxAge = content.bundle.country.lifeTable.maxAge
  let alive = 1
  let expectancy = 0
  const survival: Record<number, number> = {}
  for (let month = 0; month <= maxAge * 12; month++) {
    const age = Math.floor(month / 12)
    if (month % 12 === 0 && SURVIVAL_AGES.includes(age)) survival[age] = alive
    const q = monthlyFromAnnual(content.annualMortality(sex, age))
    expectancy += (alive * q * (month + 0.5)) / 12
    alive *= 1 - q
  }
  return { lifeExpectancy: expectancy, survival }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

function standardError(xs: number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  const variance = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)
  return Math.sqrt(variance / xs.length)
}

export interface BatchSummary {
  lives: number
  bySex: Record<'male' | 'female', { lives: number; lifeExpectancy: number; standardError: number; target: number; survival: Record<number, { simulated: number; target: number }> }>
  maleShare: number
  infantMortalityPer1000: { simulated: number; target: number }
  fluPerPersonYear: number
  decisionsPerYearByStage: Record<string, number>
  significantSourceShares: Record<string, number>
  cardioAt60ByActivity: Record<string, { lives: number; mean: number }>
  text: {
    feedLinesPerLife: number
    distinctVariantsUsed: number
    /** Variants with the highest average uses per life. */
    mostUsed: Array<{ variant: string; perLife: number; maxInOneLife: number }>
    /** Share of lives in which some variant appeared more than twice (design target: none). */
    livesWithAVariantOverTwice: number
  }
  invariantProblems: string[]
  msPerSimulatedYear: number
}

export function summarize(results: LifeResult[], content: Prepared, elapsedMs: number): BatchSummary {
  const bySex = {} as BatchSummary['bySex']
  for (const sex of ['male', 'female'] as const) {
    const group = results.filter((r) => r.sex === sex)
    const ages = group.map((r) => r.ageAtDeath)
    const target = tableTargets(content, sex)
    const survival: Record<number, { simulated: number; target: number }> = {}
    for (const age of SURVIVAL_AGES) {
      survival[age] = { simulated: group.filter((r) => r.simulatedYears >= age).length / Math.max(1, group.length), target: target.survival[age]! }
    }
    bySex[sex] = { lives: group.length, lifeExpectancy: mean(ages), standardError: standardError(ages), target: target.lifeExpectancy, survival }
  }

  const totalYears = results.reduce((a, r) => a + r.simulatedYears, 0)
  const stageYears: Record<string, number> = {}
  const stageDecisions: Record<string, number> = {}
  const sources: Record<string, number> = {}
  const variantTotals: Record<string, number> = {}
  const variantMax: Record<string, number> = {}
  let overTwice = 0
  for (const r of results) {
    for (const s in r.yearsInStage) stageYears[s] = (stageYears[s] ?? 0) + r.yearsInStage[s]!
    for (const s in r.decisionsOpened) stageDecisions[s] = (stageDecisions[s] ?? 0) + r.decisionsOpened[s]!
    for (const s in r.significantBySource) sources[s] = (sources[s] ?? 0) + r.significantBySource[s]!
    let any = false
    for (const v in r.variantCounts) {
      const n = r.variantCounts[v]!
      variantTotals[v] = (variantTotals[v] ?? 0) + n
      variantMax[v] = Math.max(variantMax[v] ?? 0, n)
      if (n > 2) any = true
    }
    if (any) overTwice++
  }
  const sourceTotal = Object.values(sources).reduce((a, b) => a + b, 0)

  const cardio: BatchSummary['cardioAt60ByActivity'] = {}
  for (const level of content.bundle.body.activityLevels) {
    const values = results.filter((r) => r.activityAt60 === level.id && r.cardioAt60 !== null).map((r) => r.cardioAt60!)
    cardio[level.id] = { lives: values.length, mean: mean(values) }
  }

  const male = bySex.male.lives
  const tableInfant = (sex: 'male' | 'female'): number => 1 - tableTargets(content, sex).survival[1]!
  return {
    lives: results.length,
    bySex,
    maleShare: male / Math.max(1, results.length),
    infantMortalityPer1000: {
      simulated: (1000 * results.filter((r) => r.simulatedYears < 1).length) / Math.max(1, results.length),
      target: 1000 * ((male * tableInfant('male') + bySex.female.lives * tableInfant('female')) / Math.max(1, results.length)),
    },
    fluPerPersonYear: results.reduce((a, r) => a + r.fluCount, 0) / totalYears,
    decisionsPerYearByStage: Object.fromEntries(Object.keys(stageYears).map((s) => [s, (stageDecisions[s] ?? 0) / stageYears[s]!])),
    significantSourceShares: Object.fromEntries(Object.entries(sources).map(([s, n]) => [s, n / Math.max(1, sourceTotal)])),
    cardioAt60ByActivity: cardio,
    text: {
      feedLinesPerLife: mean(results.map((r) => r.feedLines)),
      distinctVariantsUsed: Object.keys(variantTotals).length,
      mostUsed: Object.entries(variantTotals)
        .map(([variant, total]) => ({ variant, perLife: total / results.length, maxInOneLife: variantMax[variant]! }))
        .sort((a, b) => b.perLife - a.perLife)
        .slice(0, 12),
      livesWithAVariantOverTwice: overTwice / Math.max(1, results.length),
    },
    invariantProblems: [...new Set(results.flatMap((r) => r.invariantProblems))],
    msPerSimulatedYear: elapsedMs / totalYears,
  }
}

export interface BatchOptions {
  lives: number
  seed: string
  strategy: Strategy | 'mixed'
  /** Index of the first life; lets several workers share one batch. Life i always has seed `${seed}-${i}`. */
  from?: number
}

export function runBatch(options: BatchOptions, env: EngineEnv): LifeResult[] {
  const mixed: Strategy[] = ['persona', 'persona', 'persona', 'persona', 'persona', 'persona', 'active', 'sedentary', 'random', 'random']
  const results: LifeResult[] = []
  const from = options.from ?? 0
  for (let i = from; i < from + options.lives; i++) {
    const strategy = options.strategy === 'mixed' ? mixed[i % mixed.length]! : options.strategy
    results.push(runLife(`${options.seed}-${i}`, strategy, env))
  }
  return results
}
