/** Small helpers for people, households and how people are related. */

import { EDU_LEVELS, type EduLevel } from './content/country-schema'
import type { Education, GameState, Household, Person } from './state'

export function ageYears(person: Person, month: number): number {
  return Math.floor(((person.died?.at ?? month) - person.born) / 12)
}

export function blankEducation(status: Education['status'], level: EduLevel): Education {
  return {
    status,
    program: null,
    level,
    grade: null,
    school: null,
    courseLevel: 'regular',
    lastReport: null,
    hs: { gpaSum: 0, years: 0, rigorSum: 0 },
    standing: 0,
    test: null,
    disengagement: 0,
    applications: [],
    plan: null,
    college: null,
    loans: 0,
  }
}

/** Schooling as a rough z-score, for where it stands in for a parent's own ability or habits. */
const EDUCATION_Z: Record<EduLevel, number> = { less_than_hs: -1.3, high_school: -0.6, some_college: 0, associate: 0.3, bachelor: 0.9, graduate: 1.5 }

export function educationZ(level: EduLevel): number {
  return EDUCATION_Z[level]
}

export function educationRank(level: EduLevel): number {
  return EDU_LEVELS.indexOf(level)
}

export function householdOf(state: GameState, person: Person): Household | null {
  return person.householdId ? (state.households[person.householdId] ?? null) : null
}

export function parentsOf(state: GameState, person: Person): Person[] {
  const out: Person[] = []
  for (const id of [person.motherId, person.fatherId]) {
    const parent = id ? state.people[id] : undefined
    if (parent) out.push(parent)
  }
  return out
}

/** Living parents who share the person's household. */
export function parentsAtHome(state: GameState, person: Person): Person[] {
  return parentsOf(state, person).filter((p) => !p.died && p.householdId !== null && p.householdId === person.householdId)
}

export function childrenOf(state: GameState, parent: Person): Person[] {
  return Object.values(state.people)
    .filter((p) => p.motherId === parent.id || p.fatherId === parent.id)
    .sort((a, b) => a.born - b.born || (a.id < b.id ? -1 : 1))
}

export function siblingsOf(state: GameState, person: Person): Person[] {
  return Object.values(state.people)
    .filter((p) => p.id !== person.id && ((p.motherId !== null && p.motherId === person.motherId) || (p.fatherId !== null && p.fatherId === person.fatherId)))
    .sort((a, b) => a.born - b.born || (a.id < b.id ? -1 : 1))
}

export type Relation = 'self' | 'mother' | 'father' | 'brother' | 'sister' | 'son' | 'daughter' | 'other'

/** What `other` is to `self`. */
export function relationOf(self: Person, other: Person): Relation {
  if (other.id === self.id) return 'self'
  if (other.id === self.motherId) return 'mother'
  if (other.id === self.fatherId) return 'father'
  if (other.motherId === self.id || other.fatherId === self.id) return other.sex === 'male' ? 'son' : 'daughter'
  if ((other.motherId !== null && other.motherId === self.motherId) || (other.fatherId !== null && other.fatherId === self.fatherId)) return other.sex === 'male' ? 'brother' : 'sister'
  return 'other'
}

export function leaveHousehold(state: GameState, person: Person): void {
  const home = householdOf(state, person)
  if (home) home.members = home.members.filter((id) => id !== person.id)
  person.householdId = null
}

export function joinHousehold(state: GameState, person: Person, household: Household): void {
  leaveHousehold(state, person)
  household.members.push(person.id)
  person.householdId = household.id
}
