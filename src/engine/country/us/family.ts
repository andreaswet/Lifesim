/**
 * Families (design §7.11): who a child is born to, and what happens in that household while they
 * grow up. Parents and siblings are full people who run through the same systems as the player, so
 * a childhood is lived inside someone else's simulation: a father is out of work because the job
 * market put him there, not because a "dad loses job" event fired.
 *
 * Milestone 2 simplifications, each recorded in the design document: parents do not re-partner,
 * a later child of separated parents has the same father, and nobody moves house.
 */

import { EDU_LEVELS, type EduLevel } from '../../content/country-schema'
import { clamp, dexp, dlog, dpow, logistic, logit } from '../../core/dmath'
import { monthOf } from '../../core/time'
import { emitFact, type Ctx } from '../../context'
import { ageYears, blankEducation, childrenOf, educationRank, educationZ, householdOf, joinHousehold, leaveHousehold, parentsAtHome, parentsOf, relationOf } from '../../people'
import { livingPeople, newId, player, type Household, type Person, type StartOptions } from '../../state'
import { backfillSchooling } from './education'
import { defaultMoneyPolicies, divideMoney, marketRent, newHousehold, povertyLine, settleEstate, settleHousehold } from './household'
import { tellPlayer } from './news'
import { currentIncome, settleFounder, stopWork } from './work'
import { childGenes, founderGenes, realizeAptitudes, realizeTraits } from './genetics'

const ADULT = 18

/** The parts of a context that reading family circumstances needs. */
type Reader = Pick<Ctx, 'state' | 'content'>

export { povertyLine }

/** A household's yearly income in start-year dollars. */
export function realIncome(ctx: Reader, household: Household): number {
  return household.income / ctx.state.world.priceLevel
}

/** Household income against its needs, as a z-score: 0 is about three times the poverty line. */
export function incomeZ(ctx: Reader, household: Household): number {
  const ratio = Math.max(realIncome(ctx, household), 4000) / povertyLine(ctx, Math.max(1, household.members.length))
  return clamp((dlog(ratio) - 1.1) / 0.75, -2.5, 2.5)
}

/** How much time and attention a parent gives, as a z-score. */
function involvementOf(ctx: Reader, parent: Person): number {
  const w = ctx.content.bundle.country.family.parenting.involvement
  const work = parent.work
  return (
    w.education * educationZ(parent.education.level) +
    w.conscientiousness * (parent.traits.conscientiousness ?? 0) +
    w.agreeableness * (parent.traits.agreeableness ?? 0) +
    (work?.job && work.job.hoursPerWeek >= 30 ? w.fullTimeWork : 0) +
    (work?.status === 'unemployed' ? w.unemployed : 0)
  )
}

export function involvement(ctx: Reader, child: Person): number {
  const parents = parentsAtHome(ctx.state, child)
  if (parents.length === 0) return -1.2
  const w = ctx.content.bundle.country.family.parenting.involvement
  const mean = parents.reduce((a, p) => a + involvementOf(ctx, p), 0) / parents.length
  return mean + (parents.length === 1 ? w.loneParent : 0)
}

/** How much order the parents impose on a child's day, as a z-score. */
export function parentalStructure(ctx: Reader, child: Person): number {
  const parents = parentsAtHome(ctx.state, child)
  if (parents.length === 0) return -0.8
  return parents.reduce((a, p) => a + (p.traits.conscientiousness ?? 0) + 0.3 * educationZ(p.education.level), 0) / parents.length
}

/** The household's support for a child's learning, as a z-score (design §7.11). */
export function homeSupport(ctx: Reader, child: Person): number {
  const w = ctx.content.bundle.country.family.parenting.homeSupport
  const home = householdOf(ctx.state, child)
  const parents = parentsAtHome(ctx.state, child)
  const education = parents.length ? parents.reduce((a, p) => a + educationZ(p.education.level), 0) / parents.length : -0.6
  const income = home ? incomeZ(ctx, home) : -1
  return (w.parentEducation * education + w.income * income + w.involvement * involvement(ctx, child)) / w.scale
}

/** Mean schooling of a person's parents, as a z-score, whether or not they live together. */
export function parentEducationZ(ctx: Reader, person: Person): number {
  const parents = parentsOf(ctx.state, person)
  return parents.length ? parents.reduce((a, p) => a + educationZ(p.education.level), 0) / parents.length : 0
}

export function recomputeIncome(ctx: Ctx, household: Household): void {
  const { state } = ctx
  const support = ctx.content.bundle.country.labor.childSupport
  let income = 0
  for (const id of household.members) {
    const member = state.people[id]
    if (member) income += currentIncome(ctx, member)
  }
  // Child support from a living parent who lives elsewhere, when he or she pays at all.
  const payers = new Set<string>()
  for (const id of household.members) {
    const child = state.people[id]
    if (!child || ageYears(child, state.now) >= ADULT) continue
    for (const parent of parentsOf(state, child)) {
      if (parent.died || parent.householdId === household.id || payers.has(parent.id)) continue
      if (parent.flags.paysSupport === true) {
        payers.add(parent.id)
        income += currentIncome(ctx, parent) * support.shareOfEarnings
      }
    }
  }
  household.income = Math.round(income)
}

function pickName(ctx: Ctx, list: readonly string[], taken: Set<string>, ...key: Array<string | number>): string {
  for (let i = 0; i < 20; i++) {
    const name = ctx.rng.pick(list, 'family.name', ...key, i)
    if (!taken.has(name)) {
      taken.add(name)
      return name
    }
  }
  return list[0]!
}

function weightedKey<K extends string>(ctx: Ctx, shares: Record<K, number>, ...key: Array<string | number>): K {
  const keys = Object.keys(shares) as K[]
  return keys[Math.max(0, ctx.rng.weighted(keys.map((k) => shares[k]), 'family.draw', ...key))]!
}

/** Body stocks for someone who enters the simulation already grown: where their habits hold them. */
function settledBody(ctx: Ctx, bornMonth: number, activity: string): Person['body'] {
  const { content, state } = ctx
  const level = content.bundle.body.activityLevels[content.activityIndex.get(activity) ?? 0]!
  const age = (state.now - bornMonth) / 12
  return { cardio: content.envelope('cardio', age) * (level.sustains.cardio ?? 0), strength: content.envelope('strength', age) * (level.sustains.strength ?? 0) }
}

function defaultPolicies(ctx: Ctx, activity: string): Person['policies'] {
  const c = ctx.content.bundle.country
  return { activity, study: c.education.k12.study.default, effort: c.labor.performance.default, search: 'none', lifestyle: c.money.living.default, saving: c.money.saving.default }
}

function makeAdult(ctx: Ctx, init: { first: string; family: string; sex: 'male' | 'female'; ethnicity: string; ageYears: number; education: EduLevel }): Person {
  const { state, content, rng } = ctx
  const id = newId(state, 'p')
  const cfg = content.bundle.country.family.inheritance
  const born = state.now - init.ageYears * 12 - rng.int(12, 'family.birthMonth', id)
  const genes = founderGenes(rng, id, cfg, init.education)
  return {
    id,
    name: { first: init.first, family: init.family },
    sex: init.sex,
    ethnicity: init.ethnicity,
    born,
    birthDay: rng.range(1, 28, 'family.birthDay', id),
    motherId: null,
    fatherId: null,
    partner: null,
    householdId: null,
    genes,
    // Their own childhood home is unknown, so it is one more draw.
    aptitudes: realizeAptitudes(rng, id, cfg, genes, rng.normal('family.ownChildhood', id)),
    traits: realizeTraits(rng, id, cfg, genes),
    skills: {},
    body: settledBody(ctx, born, 'light'),
    strain: 0,
    policies: defaultPolicies(ctx, 'light'),
    education: blankEducation('not_modeled', init.education),
    credentials: [],
    work: null,
    money: null,
    nextBirth: null,
    flags: {},
    eventHistory: {},
  }
}

function makeChild(ctx: Ctx, init: { id?: string; first: string; family: string; sex: 'male' | 'female'; born: number; birthDay?: number; mother: Person; father: Person }): Person {
  const { state, content, rng } = ctx
  const id = init.id ?? newId(state, 'p')
  const cfg = content.bundle.country.family.inheritance
  const genes = childGenes(rng, id, init.mother.genes, init.father.genes)
  const body = content.bundle.body
  const newborn = init.born >= state.now
  return {
    id,
    name: { first: init.first, family: init.family },
    sex: init.sex,
    // A child of parents from different groups is counted in the last group.
    ethnicity: init.mother.ethnicity === init.father.ethnicity ? init.mother.ethnicity : content.bundle.country.people.groups[content.bundle.country.people.groups.length - 1]!.id,
    born: init.born,
    birthDay: init.birthDay ?? rng.range(1, 28, 'family.birthDay', id),
    motherId: init.mother.id,
    fatherId: init.father.id,
    partner: null,
    householdId: null,
    genes,
    aptitudes: {}, // set once the household exists, since the home is part of them
    traits: realizeTraits(rng, id, cfg, genes),
    skills: {},
    body: newborn ? { cardio: body.stocks.cardio!.atBirth, strength: body.stocks.strength!.atBirth } : settledBody(ctx, init.born, body.defaultActivity),
    strain: 0,
    policies: defaultPolicies(ctx, body.defaultActivity),
    education: blankEducation('not_yet', 'less_than_hs'),
    credentials: [],
    work: null,
    money: null,
    nextBirth: null,
    flags: {},
    eventHistory: {},
  }
}

function settleChild(ctx: Ctx, child: Person): void {
  const cfg = ctx.content.bundle.country.family.inheritance
  child.aptitudes = realizeAptitudes(ctx.rng, child.id, cfg, child.genes, homeSupport(ctx, child))
}

/** Decides, when a child is born, whether and when the mother will have another. */
function planNextBirth(ctx: Ctx, mother: Person): void {
  const cfg = ctx.content.bundle.country.family.furtherBirth
  const parity = childrenOf(ctx.state, mother).length
  const chance = cfg.probabilityByParity[Math.min(parity, cfg.probabilityByParity.length) - 1] ?? 0
  mother.nextBirth = null
  if (!ctx.rng.chance(chance, 'family.another', mother.id, parity)) return
  const due = ctx.state.now + ctx.rng.range(cfg.gapMonths[0], cfg.gapMonths[1], 'family.gap', mother.id, parity)
  if ((due - mother.born) / 12 <= cfg.maxMotherAge) mother.nextBirth = due
}

/**
 * Builds the family the player is born into and returns the player, already placed in it.
 * Called once, with `state.now` at the month of birth.
 */
export function createFamily(ctx: Ctx, start: StartOptions, self: { sex: 'male' | 'female'; birthDay: number }): Person {
  const { state, content, rng } = ctx
  const country = content.bundle.country
  const cfg = country.family

  const stateId = start.state && country.states.some((s) => s.id === start.state) ? start.state : country.states[Math.max(0, rng.weighted(country.states.map((s) => s.population), 'family.state'))]!.id

  // Who the parents are (design decision Q1). The player may have asked; otherwise it follows US births.
  const groups = country.people.groups
  const lastGroup = groups[groups.length - 1]!
  const asked = groups.find((g) => g.id === start.ethnicity)
  const group = asked ?? groups[Math.max(0, rng.weighted(groups.map((g) => g.share), 'family.group'))]!
  const sameGroup = (asked !== undefined && asked.id !== lastGroup.id) || rng.chance(country.people.sameGroup, 'family.sameGroup')
  const fatherGroup = sameGroup ? group : (groups.filter((g) => g.id !== group.id)[Math.max(0, rng.weighted(groups.filter((g) => g.id !== group.id).map((g) => g.share), 'family.fatherGroup'))] ?? group)

  // Mother: schooling given her group, then age given schooling.
  const motherEducation = weightedKey(ctx, group.motherEducation, 'motherEducation')
  const ageCfg = cfg.motherAge.byEducation[motherEducation]
  let motherAge = Math.round(ageCfg.mean)
  for (let i = 0; i < 30; i++) {
    const draw = Math.round(ageCfg.mean + cfg.motherAge.sd * rng.normal('family.motherAge', i))
    if (draw >= Math.max(cfg.motherAge.min, ageCfg.min) && draw <= cfg.motherAge.max) {
      motherAge = draw
      break
    }
  }

  // Partnership at the birth.
  const unmarried = rng.chance(logistic(logit(cfg.partnership.unmarriedByEducation[motherEducation]) + group.unmarried), 'family.unmarried')
  const status: 'married' | 'cohabiting' | 'apart' = !unmarried ? 'married' : rng.chance(cfg.partnership.cohabitingShareOfUnmarried, 'family.cohabiting') ? 'cohabiting' : 'apart'

  // Older brothers and sisters: as many as the birth order says and the mother's age allows.
  let order = Math.max(0, rng.weighted(cfg.birthOrder.shares, 'family.birthOrder'))
  const olderAges: number[] = [] // in months, at the player's birth
  let gap = 0
  for (let i = 0; i < order; i++) {
    gap += Math.round(12 * (cfg.birthOrder.spacingYears[0] + (cfg.birthOrder.spacingYears[1] - cfg.birthOrder.spacingYears[0]) * rng.float('family.spacing', i)))
    if (motherAge - gap / 12 < 15) break
    olderAges.push(gap)
  }
  order = olderAges.length

  // Father: age near hers, schooling usually near hers.
  // He was at least the minimum age when the eldest child was born.
  const eldest = order > 0 ? Math.ceil(olderAges[order - 1]! / 12) : 0
  const fatherAge = Math.max(cfg.father.minAge + eldest, Math.round(motherAge + cfg.father.ageGap.mean + cfg.father.ageGap.sd * rng.normal('family.fatherAge')))
  let fatherEducation: EduLevel = motherEducation
  const u = rng.float('family.fatherEducation')
  if (u >= cfg.father.sameEducation + cfg.father.adjacentEducation) {
    fatherEducation = weightedKey(ctx, fatherGroup.motherEducation, 'fatherEducation')
  } else if (u >= cfg.father.sameEducation) {
    const rank = educationRank(motherEducation) + (rng.chance(0.5, 'family.fatherEducationStep') ? 1 : -1)
    fatherEducation = EDU_LEVELS[clamp(rank, 0, EDU_LEVELS.length - 1)]!
  }
  // Schooling takes years; a very young father cannot have finished much of it.
  const maxRank = fatherAge < 18 ? 0 : fatherAge < 20 ? 2 : fatherAge < 22 ? 3 : fatherAge < 24 ? 4 : 5
  if (educationRank(fatherEducation) > maxRank) fatherEducation = EDU_LEVELS[maxRank]!

  // Names. The child takes the father's family name when the parents live together.
  const taken = new Set<string>()
  if (start.firstName?.trim()) taken.add(start.firstName.trim())
  const fatherFamily = start.familyName?.trim() && status !== 'apart' ? start.familyName.trim() : rng.pick(country.names.family, 'family.familyName', 'father')
  const motherFamily = status === 'married' ? fatherFamily : start.familyName?.trim() && status === 'apart' ? start.familyName.trim() : rng.pick(country.names.family, 'family.familyName', 'mother')
  const childFamily = status === 'apart' ? motherFamily : fatherFamily

  const mother = makeAdult(ctx, { first: pickName(ctx, country.names.female, taken, 'mother'), family: motherFamily, sex: 'female', ethnicity: group.id, ageYears: motherAge, education: motherEducation })
  const father = makeAdult(ctx, { first: pickName(ctx, country.names.male, taken, 'father'), family: fatherFamily, sex: 'male', ethnicity: fatherGroup.id, ageYears: fatherAge, education: fatherEducation })
  state.people[mother.id] = mother
  state.people[father.id] = father
  father.flags.paysSupport = rng.chance(country.labor.childSupport.paysAtAll, 'family.paysSupport', father.id)
  mother.flags.paysSupport = rng.chance(country.labor.childSupport.paysAtAll, 'family.paysSupport', mother.id)
  // They live somewhere before anything else is known; the neighborhood is settled once their work is.
  const home = newHousehold(ctx, stateId, 3, 'home')
  const fatherHome = status === 'apart' ? newHousehold(ctx, stateId, 3, 'father') : home
  joinHousehold(state, mother, home)
  joinHousehold(state, father, fatherHome)
  settleFounder(ctx, mother, 'mother')
  settleFounder(ctx, father, 'father')

  const me = makeChild(ctx, {
    id: 'p1',
    first: start.firstName?.trim() || pickName(ctx, country.names[self.sex], taken, 'self'),
    family: childFamily,
    sex: self.sex,
    born: state.now,
    birthDay: self.birthDay,
    mother,
    father,
  })
  state.people[me.id] = me

  const older: Person[] = olderAges.map((months, i) => {
    const sex = rng.chance(0.512, 'family.siblingSex', i) ? 'male' : 'female'
    const sibling = makeChild(ctx, { first: pickName(ctx, country.names[sex], taken, 'sibling', i), family: childFamily, sex, born: state.now - months, mother, father })
    state.people[sibling.id] = sibling
    return sibling
  })

  // The neighborhood follows the family's income loosely; schools follow the neighborhood.
  const provisional = (dlog(Math.max(8000, (currentIncome(ctx, mother) + (status === 'apart' ? 0 : currentIncome(ctx, father))) / state.world.priceLevel) / povertyLine(ctx, 3 + order)) - 1.1) / 0.75
  const w = cfg.neighborhood.incomeWeight
  const latent = w * clamp(provisional, -2.5, 2.5) + Math.sqrt(1 - w * w) * rng.normal('family.neighborhood')
  const tier = latent < -0.84 ? 1 : latent < -0.25 ? 2 : latent < 0.25 ? 3 : latent < 0.84 ? 4 : 5

  const place = (household: Household, to: number): void => {
    household.neighborhood = to
    household.schools.quality += (to - 3) * cfg.neighborhood.schoolQualityPerTier
  }
  place(home, tier)
  for (const child of [...older, me]) joinHousehold(state, child, home)
  if (status === 'apart') {
    place(fatherHome, Math.max(1, tier - 1))
  } else {
    const since = state.now - Math.min(motherAge - 16, order > 0 ? Math.round(olderAges[order - 1]! / 12) + 1 : 2) * 12
    mother.partner = { id: father.id, status, since }
    father.partner = { id: mother.id, status, since }
  }
  for (const h of Object.values(state.households)) recomputeIncome(ctx, h)
  settleHousehold(ctx, home, status === 'apart' ? [mother] : [mother, father])
  if (status === 'apart') settleHousehold(ctx, fatherHome, [father])
  for (const parent of [mother, father]) parent.flags['money.set'] = true

  const willing = country.education.paying.parents
  home.collegeWillingness = dexp(willing.willingnessSd * rng.normal('family.willingness')) * (1 + willing.willingnessPerEducationStep * ((educationRank(motherEducation) + educationRank(fatherEducation)) / 2 - 2))

  for (const child of [...older, me]) settleChild(ctx, child)
  for (const sibling of older) backfillSchooling(ctx, sibling)
  planNextBirth(ctx, mother)
  return me
}

function separate(ctx: Ctx, a: Person, b: Person): void {
  const { state, content, rng } = ctx
  const cfg = content.bundle.country.family
  const mother = a.sex === 'female' ? a : b
  const father = mother === a ? b : a
  const home = householdOf(state, mother)
  if (!home) return
  const withMother = rng.chance(cfg.separation.childrenStayWithMother, 'family.custody', mother.id, state.now)
  const stays = withMother ? mother : father
  const leaves = withMother ? father : mother

  mother.partner = null
  father.partner = null
  const away = newHousehold(ctx, home.state, Math.max(1, home.neighborhood - 1), `${leaves.id}:${state.now}`)
  joinHousehold(state, leaves, away)
  divideMoney(ctx, mother, father, stays)
  away.housing = { tenure: 'rent', shared: false, payer: leaves.id, rent: marketRent(ctx, away.state, away.neighborhood, 1, false), rentSet: state.now, arrears: 0, mortgage: null }
  // Grown children who still live at home stay where they are.
  home.disruption += 0.6
  if (mother.nextBirth !== null && !rng.chance(cfg.furtherBirth.afterSeparation, 'family.keepPlan', mother.id, state.now)) mother.nextBirth = null
  recomputeIncome(ctx, home)
  recomputeIncome(ctx, away)

  const self = player(state)
  if (!self.died && (self.motherId === mother.id || self.fatherId === father.id)) {
    emitFact(
      ctx,
      { kind: 'parents_separated', subject: self, data: { who: leaves.id, stays: stays.id, relation: relationOf(self, leaves), atHome: self.householdId === home.id, age: ageYears(self, state.now) }, significant: true },
      { sourceClass: 'npc' },
    )
  }
}

function birth(ctx: Ctx, mother: Person): void {
  const { state, content, rng } = ctx
  const home = householdOf(state, mother)
  const previous = childrenOf(state, mother)
  const fatherId = mother.partner?.id ?? previous[previous.length - 1]?.fatherId ?? null
  const father = fatherId ? state.people[fatherId] : undefined
  mother.nextBirth = null
  if (!home || !father) return
  const taken = new Set(Object.values(state.people).map((p) => p.name.first))
  const sex = rng.chance(0.512, 'family.babySex', mother.id, state.now) ? 'male' : 'female'
  const baby = makeChild(ctx, {
    first: pickName(ctx, content.bundle.country.names[sex], taken, 'baby', mother.id, state.now),
    family: previous[previous.length - 1]?.name.family ?? mother.name.family,
    sex,
    born: state.now,
    mother,
    father,
  })
  state.people[baby.id] = baby
  joinHousehold(state, baby, home)
  settleChild(ctx, baby)
  home.disruption += 0.08
  planNextBirth(ctx, mother)
  tellPlayer(ctx, 'sibling_born', baby, { atHome: player(state).householdId === home.id })
}

/** Called when anyone dies: the people left behind rearrange themselves. */
export function familyAfterDeath(ctx: Ctx, dead: Person): void {
  const { state } = ctx
  const home = householdOf(state, dead)
  const inherited = settleEstate(ctx, dead)
  stopWork(ctx, dead)
  if (dead.partner) {
    const partner = state.people[dead.partner.id]
    if (partner) partner.partner = null
    dead.partner = null
  }
  leaveHousehold(state, dead)
  if (home) {
    home.disruption += 0.8
    // Children left with no parent at home go to the other parent if there is one. With neither,
    // they stay where they are: relatives are assumed to step in (guardians arrive in Milestone 4).
    for (const id of [...home.members]) {
      const child = state.people[id]
      if (!child || ageYears(child, state.now) >= ADULT || parentsAtHome(state, child).length > 0) continue
      const other = parentsOf(state, child).find((p) => !p.died)
      const otherHome = other ? householdOf(state, other) : null
      if (otherHome) joinHousehold(state, child, otherHome)
    }
    recomputeIncome(ctx, home)
  }
  if (dead.id !== state.playerId) tellPlayer(ctx, 'family_death', dead, { age: ageYears(dead, state.now) })
  if (inherited > 0) tellPlayer(ctx, 'inheritance', dead, { amount: inherited })
}

/** One month of family life for everyone: work, partnerships, births, and money. */
export function familyMonth(ctx: Ctx): void {
  const { state, content, rng } = ctx
  const cfg = content.bundle.country.family
  const self = player(state)

  // Spending and saving become a person's own at eighteen, and start out in character.
  for (const person of livingPeople(state)) {
    if (person.flags['money.set'] === true || ageYears(person, state.now) < ADULT) continue
    person.flags['money.set'] = true
    defaultMoneyPolicies(ctx, person)
  }

  for (const person of livingPeople(state)) {
    // Each couple is handled once, from the side of the partner with the smaller id.
    const link = person.partner
    if (!link || person.id > link.id) continue
    const other = state.people[link.id]
    if (!other || other.died) continue
    const mother = person.sex === 'female' ? person : other
    let perYear = cfg.separation.perYear[link.status]
    if ([person, other].some((p) => p.work?.status === 'unemployed')) perYear *= cfg.separation.eitherParentUnemployed
    const first = childrenOf(state, mother)[0]
    if (first && (first.born - mother.born) / 12 < 25) perYear *= cfg.separation.motherUnder25AtBirth
    if (rng.chance(1 - dpow(1 - Math.min(0.95, perYear), 1 / 12), 'family.separation', person.id, state.now)) separate(ctx, person, other)
  }

  for (const person of livingPeople(state)) {
    if (person.nextBirth !== null && person.nextBirth <= state.now) birth(ctx, person)
  }

  // Upheaval fades over about a year.
  const fade = dexp(-1 / 12)
  for (const id of Object.keys(state.households).sort()) {
    const home = state.households[id]!
    home.disruption *= fade
  }

  // The early years are read, not played (design §2.1): two short passages built from what the
  // household is like when the child is about one and a half, and about three and a half.
  const months = state.now - self.born
  if (months === 18 || months === 42) emitFact(ctx, { kind: 'early_chapter', subject: self, data: { which: months === 18 ? 'toddler' : 'small_child' } }, { sourceClass: 'npc' })

  // Each December, a parent who has now been out of work for most of a year is news again.
  if (monthOf(state.now) === 11) {
    for (const parent of parentsAtHome(state, self)) {
      const since = parent.work?.status === 'unemployed' ? parent.work.since : null
      if (since !== null && since !== undefined && state.now - since >= 9) tellPlayer(ctx, 'parent_still_out', parent, { months: state.now - since }, false)
    }
  }
}
