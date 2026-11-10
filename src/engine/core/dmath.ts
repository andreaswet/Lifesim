/**
 * Deterministic math.
 *
 * ECMAScript only requires Math.exp / Math.log / Math.pow to be "implementation-approximated", so
 * two JavaScript engines may return results that differ in the last bit. A life must replay
 * identically in every browser and in Node, so the simulation uses these implementations instead.
 * They are built only from + - * / and Math.sqrt, which IEEE 754 defines exactly.
 */

const LN2_HI = 6.93147180369123816490e-1
const LN2_LO = 1.90821492927058770002e-10
const INV_LN2 = 1.44269504088896338700
const SQRT2 = 1.4142135623730951
const SQRT1_2 = 0.7071067811865476

/** Exact powers of two for exponents -1022..1023, built by doubling and halving. */
const POW2_POS: number[] = [1]
const POW2_NEG: number[] = [1]
for (let i = 1; i <= 1023; i++) POW2_POS.push(POW2_POS[i - 1]! * 2)
for (let i = 1; i <= 1022; i++) POW2_NEG.push(POW2_NEG[i - 1]! / 2)

function scalb(x: number, k: number): number {
  while (k > 1023) {
    x *= POW2_POS[1023]!
    k -= 1023
  }
  while (k < -1022) {
    x *= POW2_NEG[1022]!
    k += 1022
  }
  return k >= 0 ? x * POW2_POS[k]! : x * POW2_NEG[-k]!
}

export function dexp(x: number): number {
  if (x !== x) return NaN
  if (x > 709.78) return Infinity
  if (x < -745.13) return 0
  const k = Math.round(x * INV_LN2)
  // Two-part ln2 keeps the reduced argument accurate; |r| <= 0.347.
  const r = x - k * LN2_HI - k * LN2_LO
  let term = 1
  let sum = 1
  for (let i = 1; i <= 14; i++) {
    term = (term * r) / i
    sum += term
  }
  return scalb(sum, k)
}

export function dlog(x: number): number {
  if (x !== x || x < 0) return NaN
  if (x === 0) return -Infinity
  if (x === Infinity) return Infinity
  let m = x
  let k = 0
  while (m >= SQRT2) {
    m /= 2
    k++
  }
  while (m < SQRT1_2) {
    m *= 2
    k--
  }
  // log(m) = 2 * atanh(s), s = (m - 1) / (m + 1), |s| <= 0.172
  const s = (m - 1) / (m + 1)
  const s2 = s * s
  let term = s
  let sum = s
  for (let n = 3; n <= 27; n += 2) {
    term *= s2
    sum += term / n
  }
  return k * LN2_HI + (2 * sum + k * LN2_LO)
}

/** a^b for a > 0. */
export function dpow(a: number, b: number): number {
  if (b === 0) return 1
  if (a === 0) return b > 0 ? 0 : Infinity
  return dexp(b * dlog(a))
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

export function logit(p: number): number {
  return dlog(p / (1 - p))
}

export function logistic(x: number): number {
  return 1 / (1 + dexp(-x))
}

/**
 * Inverse of the standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9).
 * Used to turn one uniform draw into one normal draw without trigonometry.
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  if (p < pLow) {
    const q = Math.sqrt(-2 * dlog(p))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * dlog(1 - p))
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
}

/**
 * The stock primitive (design §3.1): move a fraction of the way toward a target, with separate
 * time constants for rising and falling. `dt` and the taus are in months.
 */
export function approach(x: number, target: number, tauUp: number, tauDown: number, dt = 1): number {
  const tau = target >= x ? tauUp : tauDown
  if (tau <= 0) return target
  return x + (target - x) * (1 - dexp(-dt / tau))
}

/** Linear interpolation through sorted [x, y] points, flat beyond both ends. */
export function interpolate(points: ReadonlyArray<readonly [number, number]>, x: number): number {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return 0
  if (x <= first[0]) return first[1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1]!
    const p1 = points[i]!
    if (x <= p1[0]) {
      const t = (x - p0[0]) / (p1[0] - p0[0])
      return p0[1] + t * (p1[1] - p0[1])
    }
  }
  return last[1]
}
