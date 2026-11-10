import { describe, expect, it } from 'vitest'
import { checkInvariants, perceive, simulationHash, step, type GameState } from '../src/engine'
import { childrenOf, parentsOf, siblingsOf } from '../src/engine/people'
import { createLife } from '../src/engine'
import { liveUntil, newLife, realContent, testEnv } from './helpers'

const content = realContent()
const env = testEnv(content, false)
const narrated = testEnv(content, true)
const self = (s: GameState) => s.people.p1!
const kinds = (s: GameState, kind: string) => s.log.filter((e) => e.fact.kind === kind)

/** The first seed, of a numbered run, whose life satisfies a condition when lived to an age. */
function findLife(prefix: string, untilAge: number, test: (s: GameState) => boolean, tries = 400): GameState {
  for (let i = 0; i < tries; i++) {
    const s = liveUntil(newLife(`${prefix}-${i}`, narrated, 200), narrated, (x) => x.now - x.people.p1!.born >= untilAge * 12)
    if (test(s)) return s
  }
  throw new Error(`no life found for ${prefix}`)
}

const families = Array.from({ length: 400 }, (_, i) => newLife(`fam-${i}`, env))

describe('the family a child is born into', () => {
  it('is complete and consistent at birth', () => {
    for (const s of families) {
      expect(checkInvariants(s, content)).toEqual([])
      const me = self(s)
      const [mother, father] = [s.people[me.motherId!]!, s.people[me.fatherId!]!]
      expect(mother.sex).toBe('female')
      expect(father.sex).toBe('male')
      const motherAge = (me.born - mother.born) / 12
      expect(motherAge).toBeGreaterThanOrEqual(15)
      expect(motherAge).toBeLessThan(47.1)
      // Everyone lives somewhere; the child lives with the mother.
      expect(me.householdId).toBe(mother.householdId)
      expect(content.bundle.country.states.some((x) => x.id === s.households[me.householdId!]!.state)).toBe(true)
      for (const sibling of siblingsOf(s, me)) {
        expect(sibling.born).toBeLessThan(me.born)
        expect((sibling.born - mother.born) / 12).toBeGreaterThanOrEqual(14)
        expect((sibling.born - father.born) / 12).toBeGreaterThanOrEqual(15)
        expect(sibling.name.first).not.toBe(me.name.first)
      }
      // Married parents share a household and a family name; the child carries it.
      if (mother.partner?.status === 'married') {
        expect(father.householdId).toBe(mother.householdId)
        expect(mother.name.family).toBe(father.name.family)
        expect(me.name.family).toBe(father.name.family)
      }
      if (!mother.partner) expect(father.householdId).not.toBe(mother.householdId)
    }
  })

  it('follows the spread of American births', () => {
    const share = (test: (s: GameState) => boolean): number => families.filter(test).length / families.length
    const mother = (s: GameState) => s.people[self(s).motherId!]!
    expect(share((s) => mother(s).partner?.status === 'married')).toBeGreaterThan(0.5)
    expect(share((s) => mother(s).partner?.status === 'married')).toBeLessThan(0.72)
    expect(share((s) => mother(s).partner === null)).toBeGreaterThan(0.08)
    expect(share((s) => mother(s).partner === null)).toBeLessThan(0.26)
    expect(share((s) => siblingsOf(s, self(s)).length === 0)).toBeGreaterThan(0.28) // first-born: 39%
    expect(share((s) => siblingsOf(s, self(s)).length === 0)).toBeLessThan(0.5)
    const ages = families.map((s) => (self(s).born - mother(s).born) / 12)
    const mean = ages.reduce((a, b) => a + b, 0) / ages.length
    expect(mean).toBeGreaterThan(28) // NCHS 2023: 29.6
    expect(mean).toBeLessThan(31)
    // Educated mothers are older and far more often married.
    const graduates = families.filter((s) => ['bachelor', 'graduate'].includes(mother(s).education.level))
    const others = families.filter((s) => ['less_than_hs', 'high_school'].includes(mother(s).education.level))
    const married = (xs: GameState[]): number => xs.filter((s) => mother(s).partner?.status === 'married').length / xs.length
    expect(married(graduates)).toBeGreaterThan(married(others) + 0.25)
  })

  it('honours the name, sex and state the player asked for', () => {
    const s = createLife({ seed: 'asked', start: { firstName: 'Wren', familyName: 'Oyelaran', sex: 'female', state: 'vt' } }, env)
    expect(self(s).name).toEqual({ first: 'Wren', family: 'Oyelaran' })
    expect(self(s).sex).toBe('female')
    expect(perceive(s, content).place).toBe('Vermont')
    expect(parentsOf(s, self(s)).some((p) => p.name.family === 'Oyelaran')).toBe(true)
  })

  it('passes traits from parents to children as inheritance should', () => {
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
    const many = Array.from({ length: 1500 }, (_, i) => newLife(`genes-${i}`, env))
    const mid = many.map((s) => (s.people[self(s).motherId!]!.genes.g! + s.people[self(s).fatherId!]!.genes.g!) / 2)
    const child = many.map((s) => self(s).genes.g!)
    // Child on mid-parent: the child is the mid-parent value plus an independent half-variance draw.
    const residual = child.map((c, i) => c - mid[i]!)
    expect(corr(mid, child)).toBeGreaterThan(0.55)
    expect(Math.abs(corr(mid, residual))).toBeLessThan(0.08)
    const variance = (xs: number[]): number => xs.reduce((a, b) => a + b * b, 0) / xs.length - (xs.reduce((a, b) => a + b, 0) / xs.length) ** 2
    expect(variance(residual)).toBeGreaterThan(0.42)
    expect(variance(residual)).toBeLessThan(0.58)
    // Variance does not shrink or grow across the generation.
    expect(variance(child)).toBeGreaterThan(0.8)
    expect(variance(child)).toBeLessThan(1.25)
    // Aptitude follows genes, but only partly.
    const aptitude = many.map((s) => self(s).aptitudes.verbal!)
    expect(corr(child, aptitude)).toBeGreaterThan(0.4)
    expect(corr(child, aptitude)).toBeLessThan(0.75)
  })

  it('is the same family every time for the same seed', () => {
    expect(simulationHash(newLife('fam-7', env))).toBe(simulationHash(families[7]!))
  })
})

describe('what happens in a family', () => {
  it('parents separate: one moves out, the child stays, and it is told from the child’s side', () => {
    const s = findLife('sep', 16, (x) => kinds(x, 'parents_separated').length > 0)
    const entry = kinds(s, 'parents_separated')[0]!
    const left = s.people[String(entry.fact.data.who)]!
    const stays = s.people[String(entry.fact.data.stays)]!
    expect(left.partner).toBeNull()
    expect(stays.partner).toBeNull()
    expect(left.householdId).not.toBe(stays.householdId)
    expect(self(s).householdId).toBe(stays.householdId)
    expect(entry.text.includes(left.name.first) || entry.text.includes(String(entry.fact.data.relation)) || entry.text.includes('parents')).toBe(true)
    expect(entry.fact.significant).toBe(true)
    expect(checkInvariants(s, content)).toEqual([])
    // The year summary of that year leads with it.
    const summary = s.log.find((e) => e.fact.kind === 'year_summary' && e.month >= entry.month)!
    expect(summary.fact.data.highlight).toBe('parents_separated')
  })

  it('a younger brother or sister is born into the household', () => {
    const s = findLife('sib', 12, (x) => kinds(x, 'sibling_born').length > 0)
    const baby = s.people[String(kinds(s, 'sibling_born')[0]!.fact.data.who)]!
    expect(baby.born).toBeGreaterThan(self(s).born)
    expect(baby.motherId).toBe(self(s).motherId)
    expect(childrenOf(s, s.people[self(s).motherId!]!).map((c) => c.id)).toContain(baby.id)
    expect(perceive(s, content).family.members.some((m) => m.id === baby.id && (m.relation === 'brother' || m.relation === 'sister'))).toBe(true)
  })

  it('a parent losing a job is news, costs the household income, and unsettles it', () => {
    const s = findLife('job', 17, (x) => kinds(x, 'parent_job_lost').length > 0)
    const entry = kinds(s, 'parent_job_lost')[0]!
    const parent = s.people[String(entry.fact.data.who)]!
    expect(['mother', 'father']).toContain(entry.fact.data.relation)
    expect(entry.text.length).toBeGreaterThan(20)
    // Replay to the month before and the month after to see the money move.
    let before = newLife(s.meta.seed, narrated, 200)
    before = liveUntil(before, narrated, (x) => x.now >= entry.month - 12)
    while (before.now < entry.month) before = step(before, { type: 'advance', until: 'month' }, narrated).state
    const home = (x: GameState) => x.households[x.people[parent.id]!.householdId!]!
    const earlier = home(before).income
    const after = step(before, { type: 'advance', until: 'month' }, narrated).state
    expect(home(after).income).toBeLessThan(earlier)
    expect(home(after).disruption).toBeGreaterThan(0.2)
  })

  it('a death in the family is told, and the household rearranges itself', () => {
    const s = findLife('death', 45, (x) => kinds(x, 'family_death').length > 0, 200)
    const entry = kinds(s, 'family_death')[0]!
    const dead = s.people[String(entry.fact.data.who)]!
    expect(dead.died).toBeDefined()
    expect(dead.householdId).toBeNull()
    expect(dead.partner).toBeNull()
    expect(Object.values(s.people).every((p) => p.partner?.id !== dead.id)).toBe(true)
    expect(entry.text).toMatch(/dies/)
    expect(perceive(s, content).family.members.find((m) => m.id === dead.id)!.age).toMatch(/^died in \d{4} at \d+$/)
    expect(checkInvariants(s, content)).toEqual([])
  })

  it('the early years are told from what the household is like', () => {
    const s = liveUntil(newLife('early-1', narrated, 200), narrated, (x) => x.now - x.people.p1!.born >= 60)
    expect(s.log[0]!.fact.kind).toBe('birth')
    expect(s.log[1]!.fact.kind).toBe('family_intro')
    const mother = s.people[self(s).motherId!]!
    expect(s.log[1]!.text).toContain(mother.name.first)
    const chapters = kinds(s, 'early_chapter')
    expect(chapters).toHaveLength(2)
    expect(chapters[0]!.text).not.toBe(chapters[1]!.text)
    // No decisions are asked of a small child.
    expect(kinds(s, 'decision_opened')).toHaveLength(0)
  })
})
