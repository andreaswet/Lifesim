import { describe, expect, it } from 'vitest'
import { runBatch, summarize } from '../src/tools/batch-lib'
import { realContent } from './helpers'

/**
 * A small batch on every test run, with wide tolerances: it catches a broken mortality or event
 * pipeline, not a 1% drift. The full comparison is `npm run batch` (see docs/CALIBRATION.md).
 */
describe('calibration smoke test', () => {
  const content = realContent()
  const started = performance.now()
  const results = runBatch({ lives: 800, seed: 'smoke', strategy: 'mixed' }, { content, narrator: null })
  const s = summarize(results, content, performance.now() - started)

  it('breaks no invariant', () => {
    expect(s.invariantProblems).toEqual([])
  })

  it('life expectancy is within sampling error of the life table, for each sex', () => {
    for (const sex of ['male', 'female'] as const) {
      const g = s.bySex[sex]
      expect(Math.abs(g.lifeExpectancy - g.target), `${sex}: ${g.lifeExpectancy.toFixed(2)} vs ${g.target.toFixed(2)}`).toBeLessThan(4 * g.standardError)
      expect(Math.abs(g.survival[65]!.simulated - g.survival[65]!.target)).toBeLessThan(0.08)
    }
  })

  it('the flu occurs at its declared base rate', () => {
    expect(s.fluPerPersonYear).toBeGreaterThan(0.08 * 0.92)
    expect(s.fluPerPersonYear).toBeLessThan(0.08 * 1.08)
  })

  it('more activity means more fitness at sixty', () => {
    const c = s.cardioAt60ByActivity
    expect(c.sedentary!.mean).toBeLessThan(c.light!.mean)
    expect(c.light!.mean).toBeLessThan(c.moderate!.mean)
    expect(c.moderate!.mean).toBeLessThan(c.active!.mean)
  })

  it('stays inside the pacing and performance budgets', () => {
    // Decisions per year stay far below one in Milestone 1; the cap is what matters later.
    for (const perYear of Object.values(s.decisionsPerYearByStage)) expect(perYear).toBeLessThan(3)
    // Design budget: under 20 ms per simulated year in Node.
    expect(s.msPerSimulatedYear).toBeLessThan(20)
  })
})
