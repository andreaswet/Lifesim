/** Absolute month index: year * 12 + month (0 = January). One tick simulates one month. */
export type MonthIndex = number

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const

export function monthIndex(year: number, month0: number): MonthIndex {
  return year * 12 + month0
}

export function yearOf(m: MonthIndex): number {
  return Math.floor(m / 12)
}

/** 0 = January. */
export function monthOf(m: MonthIndex): number {
  return ((m % 12) + 12) % 12
}

export function monthName(m: MonthIndex): string {
  return MONTH_NAMES[monthOf(m)]!
}

export type Season = 'winter' | 'spring' | 'summer' | 'autumn'

export function seasonOf(m: MonthIndex): Season {
  const mo = monthOf(m)
  if (mo === 11 || mo <= 1) return 'winter'
  if (mo <= 4) return 'spring'
  if (mo <= 7) return 'summer'
  return 'autumn'
}

export function ageInMonths(born: MonthIndex, at: MonthIndex): number {
  return at - born
}

export function ageInYears(born: MonthIndex, at: MonthIndex): number {
  return Math.floor((at - born) / 12)
}
