import { describe, expect, it } from 'vitest'
import { approach, dexp, dlog, dpow, interpolate, inverseNormalCdf } from '../src/engine/core/dmath'

const close = (a: number, b: number, rel = 1e-13): boolean => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b))

describe('deterministic math', () => {
  it('dexp agrees with Math.exp across its range', () => {
    for (let x = -700; x <= 700; x += 0.37) expect(close(dexp(x), Math.exp(x), 1e-13 * 1)).toBe(true)
    for (const x of [0, 1e-12, -1e-12, 1, -1, 0.5, 709, -745]) expect(Math.abs(dexp(x) - Math.exp(x)) <= 1e-13 * Math.exp(x) + 1e-320).toBe(true)
    expect(dexp(1000)).toBe(Infinity)
    expect(dexp(-1000)).toBe(0)
    expect(dexp(NaN)).toBeNaN()
  })

  it('dlog agrees with Math.log', () => {
    for (let e = -300; e <= 300; e += 7) {
      for (const m of [1, 1.3, 2.7, 9.99]) {
        const x = m * 10 ** e
        expect(close(dlog(x), Math.log(x), 1e-14)).toBe(true)
      }
    }
    for (let x = 0.5; x < 2; x += 0.0137) expect(Math.abs(dlog(x) - Math.log(x))).toBeLessThan(1e-15)
    expect(dlog(0)).toBe(-Infinity)
    expect(dlog(-1)).toBeNaN()
  })

  it('dpow compounds monthly probabilities back to the annual one', () => {
    for (const q of [0.0004, 0.006, 0.05, 0.3, 0.9]) {
      const monthly = 1 - dpow(1 - q, 1 / 12)
      expect(1 - (1 - monthly) ** 12).toBeCloseTo(q, 12)
    }
  })

  it('inverse normal CDF is accurate and symmetric', () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 9)
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5)
    expect(inverseNormalCdf(0.001)).toBeCloseTo(-3.090232, 5)
    expect(inverseNormalCdf(0.2)).toBeCloseTo(-inverseNormalCdf(0.8), 8)
  })

  it('approach gives diminishing returns and separate up and down speeds', () => {
    // One month at a new target moves the stock only a little (design: one gym visit does nothing).
    const oneMonth = approach(0.4, 0.8, 8, 3.5)
    expect(oneMonth - 0.4).toBeLessThan(0.05)
    // Three years gets nearly all the way.
    let x = 0.4
    const steps: number[] = []
    for (let i = 0; i < 36; i++) {
      const next = approach(x, 0.8, 8, 3.5)
      steps.push(next - x)
      x = next
    }
    expect(x).toBeGreaterThan(0.79)
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeLessThan(steps[i - 1]!)
    // Falling is faster than rising.
    expect(0.8 - approach(0.8, 0.4, 8, 3.5)).toBeGreaterThan(oneMonth - 0.4)
  })

  it('interpolates and clamps at the ends', () => {
    const curve = [
      [0, 1],
      [10, 3],
    ] as const
    expect(interpolate(curve, -5)).toBe(1)
    expect(interpolate(curve, 5)).toBe(2)
    expect(interpolate(curve, 50)).toBe(3)
  })
})
