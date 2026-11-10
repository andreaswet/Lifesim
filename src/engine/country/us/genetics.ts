/**
 * Inheritance (design §7.3, §7.5). Each person carries latent genetic values as z-scores. A child
 * gets the average of the parents plus an independent draw with half the population variance, so
 * variance stays constant across generations and siblings differ as much as they do in life.
 * What a person is actually like adds the family they grew up in and plain chance.
 */

import type { FamilyDef } from '../../content/country-schema'
import type { KeyedRng } from '../../core/rng'
import type { EduLevel } from '../../content/country-schema'

export const APTITUDES = ['verbal', 'quantitative'] as const
export const TRAITS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'] as const
/** `g` is the general factor shared by every aptitude. */
export const GENES = ['g', ...APTITUDES, ...TRAITS] as const

const SQRT_HALF = 0.7071067811865476

/**
 * Genes for someone whose parents are not simulated. Their schooling is already known, so the
 * genes are drawn to be consistent with it: an adult's aptitude correlates with their education,
 * and their genes with their aptitude.
 */
export function founderGenes(rng: KeyedRng, key: string, cfg: FamilyDef['inheritance'], education: EduLevel): Record<string, number> {
  const h = cfg.aptitude.genes
  const hp = cfg.personality.genes
  // 0.9 and 0.97 keep the population variance of aptitude and conscientiousness near 1 given
  // the spread of the education means.
  const aptitude = cfg.aptitudeByEducation[education] + 0.9 * rng.normal('genes.founder', key, 'own.aptitude')
  const conscientiousness = cfg.conscientiousnessByEducation[education] + 0.97 * rng.normal('genes.founder', key, 'own.conscientiousness')
  const genes: Record<string, number> = {}
  for (const id of GENES) genes[id] = rng.normal('genes.founder', key, id)
  genes.g = Math.sqrt(h) * aptitude + Math.sqrt(1 - h) * genes.g!
  genes.conscientiousness = Math.sqrt(hp) * conscientiousness + Math.sqrt(1 - hp) * genes.conscientiousness!
  return genes
}

export function childGenes(rng: KeyedRng, key: string, mother: Record<string, number>, father: Record<string, number>): Record<string, number> {
  const genes: Record<string, number> = {}
  for (const id of GENES) genes[id] = ((mother[id] ?? 0) + (father[id] ?? 0)) / 2 + SQRT_HALF * rng.normal('genes.child', key, id)
  return genes
}

export function realizeTraits(rng: KeyedRng, key: string, cfg: FamilyDef['inheritance'], genes: Record<string, number>): Record<string, number> {
  const hp = cfg.personality.genes
  const traits: Record<string, number> = {}
  for (const id of TRAITS) traits[id] = Math.sqrt(hp) * (genes[id] ?? 0) + Math.sqrt(1 - hp) * rng.normal('traits', key, id)
  return traits
}

/** `familyEnvironment` is the home's support for learning, as a z-score. */
export function realizeAptitudes(rng: KeyedRng, key: string, cfg: FamilyDef['inheritance'], genes: Record<string, number>, familyEnvironment: number): Record<string, number> {
  const h = cfg.aptitude.genes
  const c = cfg.aptitude.family
  const gf = cfg.generalFactor
  const aptitudes: Record<string, number> = {}
  for (const id of APTITUDES) {
    const genetic = gf * (genes.g ?? 0) + Math.sqrt(1 - gf * gf) * (genes[id] ?? 0)
    aptitudes[id] = Math.sqrt(h) * genetic + Math.sqrt(c) * familyEnvironment + Math.sqrt(1 - h - c) * rng.normal('aptitudes', key, id)
  }
  return aptitudes
}
