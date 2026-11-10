/**
 * Keyed, stateless randomness (design §4.3).
 *
 * A draw is a pure function of the life seed and a key such as
 * ('health.onset', personId, month, conditionId). There is no cursor in the game state, so:
 *  - adding a new system or event never shifts anyone else's draws;
 *  - any single draw can be reproduced in isolation;
 *  - the same life can be re-run with one thing changed and all unrelated luck stays identical.
 *
 * The hash is two MurmurHash3-style 32-bit lanes with cross-mixed finalization, giving 53 random
 * bits per draw.
 */

import { dlog, inverseNormalCdf } from './dmath'

export type KeyPart = string | number

const C1 = 0xcc9e2d51
const C2 = 0x1b873593
const D1 = 0x85ebca6b
const D2 = 0xc2b2ae35

interface Lanes {
  h1: number
  h2: number
}

function absorb(l: Lanes, v: number): void {
  let k1 = Math.imul(v, C1)
  k1 = (k1 << 15) | (k1 >>> 17)
  k1 = Math.imul(k1, C2)
  l.h1 ^= k1
  l.h1 = (l.h1 << 13) | (l.h1 >>> 19)
  l.h1 = (Math.imul(l.h1, 5) + 0xe6546b64) | 0

  let k2 = Math.imul(v, D1)
  k2 = (k2 << 16) | (k2 >>> 16)
  k2 = Math.imul(k2, D2)
  l.h2 ^= k2
  l.h2 = (l.h2 << 11) | (l.h2 >>> 21)
  l.h2 = (Math.imul(l.h2, 5) + 0x38495ab5) | 0
}

function absorbString(l: Lanes, s: string): void {
  // A leading tag and the length keep ('ab','c') distinct from ('a','bc') and from numbers.
  absorb(l, 0x53000000 | (s.length & 0xffffff))
  for (let i = 0; i < s.length; i++) absorb(l, s.charCodeAt(i))
}

function absorbPart(l: Lanes, part: KeyPart): void {
  if (typeof part === 'number') {
    if (Number.isInteger(part) && part >= -0x80000000 && part <= 0x7fffffff) {
      absorb(l, 0x4e000001)
      absorb(l, part | 0)
    } else {
      absorbString(l, String(part))
    }
  } else {
    absorbString(l, part)
  }
}

function fmix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h
}

function finish(l: Lanes): [number, number] {
  let a = fmix(l.h1 ^ Math.imul(l.h2, 0x9e3779b1))
  let b = fmix(l.h2 ^ Math.imul(a, 0x7feb352d))
  a = fmix(a ^ b)
  return [a >>> 0, b >>> 0]
}

/** Stable 64-bit hash of a string as 16 hex characters. Used for content and state hashes. */
export function hashString(s: string): string {
  const l: Lanes = { h1: 0x1234abcd, h2: 0x9e3779b9 | 0 }
  absorbString(l, s)
  const [a, b] = finish(l)
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

export class DuplicateDrawError extends Error {}

export class KeyedRng {
  private readonly base: Lanes
  private readonly streams = new Map<string, Lanes>()
  private seen: Set<string> | null

  constructor(seed: string, options: { detectDuplicates?: boolean } = {}) {
    this.base = { h1: 0x2f6e2b1, h2: 0x51ed270b }
    absorbString(this.base, seed)
    this.seen = options.detectDuplicates ? new Set() : null
  }

  /** Call at the start of each tick; only matters when duplicate detection is on. */
  beginTick(): void {
    this.seen?.clear()
  }

  /** Uniform in [0, 1). */
  float(stream: string, ...parts: KeyPart[]): number {
    if (this.seen) {
      const key = stream + '\u0001' + parts.join('\u0001')
      if (this.seen.has(key)) throw new DuplicateDrawError(`Random key drawn twice in one tick: ${stream} ${parts.join(' ')}`)
      this.seen.add(key)
    }
    let s = this.streams.get(stream)
    if (!s) {
      s = { h1: this.base.h1, h2: this.base.h2 }
      absorbString(s, stream)
      this.streams.set(stream, s)
    }
    const l: Lanes = { h1: s.h1, h2: s.h2 }
    for (const p of parts) absorbPart(l, p)
    const [a, b] = finish(l)
    return ((a >>> 5) * 67108864 + (b >>> 6)) / 9007199254740992
  }

  chance(p: number, stream: string, ...parts: KeyPart[]): boolean {
    return this.float(stream, ...parts) < p
  }

  /** Integer in [0, n). */
  int(n: number, stream: string, ...parts: KeyPart[]): number {
    return Math.floor(this.float(stream, ...parts) * n)
  }

  /** Integer in [lo, hi], both inclusive. */
  range(lo: number, hi: number, stream: string, ...parts: KeyPart[]): number {
    return lo + this.int(hi - lo + 1, stream, ...parts)
  }

  normal(stream: string, ...parts: KeyPart[]): number {
    const u = this.float(stream, ...parts)
    return inverseNormalCdf(u === 0 ? 1e-300 : u)
  }

  /** Exponential waiting time with the given mean. */
  exponential(mean: number, stream: string, ...parts: KeyPart[]): number {
    return -mean * dlog(1 - this.float(stream, ...parts))
  }

  pick<T>(items: readonly T[], stream: string, ...parts: KeyPart[]): T {
    if (items.length === 0) throw new Error(`pick from empty list (${stream})`)
    return items[this.int(items.length, stream, ...parts)]!
  }

  /** Index chosen in proportion to non-negative weights; -1 if all weights are zero. */
  weighted(weights: readonly number[], stream: string, ...parts: KeyPart[]): number {
    let total = 0
    for (const w of weights) total += w > 0 ? w : 0
    if (total <= 0) return -1
    let r = this.float(stream, ...parts) * total
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i]! > 0 ? weights[i]! : 0
      if (r < w) return i
      r -= w
    }
    return weights.length - 1
  }
}
