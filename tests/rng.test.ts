import { describe, expect, it } from 'vitest'
import { DuplicateDrawError, KeyedRng, hashString } from '../src/engine/core/rng'

describe('keyed randomness', () => {
  it('is a pure function of seed and key', () => {
    const a = new KeyedRng('seed')
    const b = new KeyedRng('seed')
    expect(a.float('x', 'p1', 5)).toBe(b.float('x', 'p1', 5))
    // Order of asking does not matter: there is no cursor.
    const first = a.float('y', 1)
    a.float('z', 2)
    expect(new KeyedRng('seed').float('y', 1)).toBe(first)
  })

  it('differs by seed, stream and every key part', () => {
    const r = new KeyedRng('seed')
    const base = r.float('s', 'a', 1)
    expect(new KeyedRng('seed2').float('s', 'a', 1)).not.toBe(base)
    expect(r.float('t', 'a', 1)).not.toBe(base)
    expect(r.float('s', 'b', 1)).not.toBe(base)
    expect(r.float('s', 'a', 2)).not.toBe(base)
    // Part boundaries matter: ('ab','c') is not ('a','bc'), and 1 is not '1'.
    expect(r.float('s', 'ab', 'c')).not.toBe(r.float('s', 'a', 'bc'))
    expect(r.float('s', 1)).not.toBe(r.float('s', '1'))
  })

  it('is uniform over sequential keys', () => {
    const r = new KeyedRng('uniformity')
    const buckets = new Array<number>(20).fill(0)
    const n = 200000
    let sum = 0
    for (let i = 0; i < n; i++) {
      const u = r.float('mortality', 'p1', 24000 + i)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
      buckets[Math.floor(u * 20)]!++
      sum += u
    }
    const expected = n / 20
    const chi2 = buckets.reduce((a, c) => a + ((c - expected) * (c - expected)) / expected, 0)
    expect(chi2).toBeLessThan(43.8) // 19 degrees of freedom, p = 0.001
    expect(sum / n).toBeCloseTo(0.5, 2)
  })

  it('is right in the low tail, where rare events live', () => {
    let hits = 0
    const n = 400000
    for (let s = 0; s < 4000; s++) {
      const r = new KeyedRng(`life-${s}`)
      for (let m = 0; m < 100; m++) if (r.float('mortality', 'p1', 24312 + m) < 0.001) hits++
    }
    const se = Math.sqrt(n * 0.001 * 0.999)
    expect(Math.abs(hits - n * 0.001)).toBeLessThan(4 * se)
  })

  it('has no correlation between neighbouring keys or neighbouring seeds', () => {
    const corr = (xs: number[], ys: number[]): number => {
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length
      const my = ys.reduce((a, b) => a + b, 0) / ys.length
      let sxy = 0
      let sxx = 0
      let syy = 0
      for (let i = 0; i < xs.length; i++) {
        sxy += (xs[i]! - mx) * (ys[i]! - my)
        sxx += (xs[i]! - mx) ** 2
        syy += (ys[i]! - my) ** 2
      }
      return sxy / Math.sqrt(sxx * syy)
    }
    const r = new KeyedRng('corr')
    const a: number[] = []
    const b: number[] = []
    const c: number[] = []
    const d: number[] = []
    for (let i = 0; i < 50000; i++) {
      a.push(r.float('k', i))
      b.push(r.float('k', i + 1))
      c.push(new KeyedRng(`s-${i}`).float('k', 7))
      d.push(new KeyedRng(`s-${i + 1}`).float('k', 7))
    }
    expect(Math.abs(corr(a, b))).toBeLessThan(0.02)
    expect(Math.abs(corr(c, d))).toBeLessThan(0.02)
  })

  it('draws normals with the right mean and spread', () => {
    const r = new KeyedRng('normal')
    let sum = 0
    let sq = 0
    const n = 100000
    for (let i = 0; i < n; i++) {
      const z = r.normal('n', i)
      sum += z
      sq += z * z
    }
    expect(sum / n).toBeCloseTo(0, 1)
    expect(Math.sqrt(sq / n)).toBeCloseTo(1, 1)
  })

  it('weighted choice follows the weights and ignores non-positive ones', () => {
    const r = new KeyedRng('weights')
    const counts = [0, 0, 0, 0]
    for (let i = 0; i < 40000; i++) counts[r.weighted([1, 0, 3, -5], 'w', i)]!++
    expect(counts[1]).toBe(0)
    expect(counts[3]).toBe(0)
    expect(counts[2]! / counts[0]!).toBeGreaterThan(2.8)
    expect(counts[2]! / counts[0]!).toBeLessThan(3.2)
    expect(r.weighted([0, 0], 'w', 'none')).toBe(-1)
  })

  it('can detect the same key drawn twice in a tick', () => {
    const r = new KeyedRng('dup', { detectDuplicates: true })
    r.float('a', 1)
    expect(() => r.float('a', 1)).toThrow(DuplicateDrawError)
    r.beginTick()
    expect(() => r.float('a', 1)).not.toThrow()
  })

  it('hashes strings stably', () => {
    expect(hashString('lifesim')).toBe(hashString('lifesim'))
    expect(hashString('lifesim')).not.toBe(hashString('lifesin'))
    expect(hashString('')).toMatch(/^[0-9a-f]{16}$/)
  })
})
