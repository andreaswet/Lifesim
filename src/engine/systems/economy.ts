/**
 * The economy (design §7.1). A business cycle moves between regimes; unemployment, inflation,
 * pay, interest rates, share prices and house prices follow it; and each sector of work drifts
 * on its own slow random walk. Every draw is keyed by the month alone, so a life's economy is the
 * same whatever anyone in it does: paired counterfactuals share their recessions.
 */

import { approach, dexp } from '../core/dmath'
import type { KeyedRng } from '../core/rng'
import type { Ctx } from '../context'
import type { Prepared } from '../content/prepare'
import type { World } from '../state'

function policyTarget(content: Prepared, inflation: number, unemployment: number): number {
  const eco = content.bundle.country.economy
  const r = eco.rates
  const usual = eco.regimes.expansion.inflation
  return Math.max(0.1, r.realNeutral + usual + r.inflationWeight * (inflation - usual) + r.unemploymentWeight * (unemployment - eco.wages.neutralUnemployment))
}

/** The economy in the month a life begins: somewhere in an expansion, with every index at 1. */
export function initWorld(content: Prepared, rng: KeyedRng, now: number): World {
  const eco = content.bundle.country.economy
  const regime = eco.regimes.expansion
  const unemployment = regime.unemployment + 0.4 * rng.float('econ.start', 'unemployment')
  const policyRate = policyTarget(content, regime.inflation, unemployment)
  const sectors: World['sectors'] = {}
  for (const sector of eco.sectors) sectors[sector.id] = { index: 1, trend: sector.trend }
  return {
    regime: 'expansion',
    regimeSince: now - rng.int(48, 'econ.start', 'months'),
    recessions: 0,
    unemployment,
    inflation: regime.inflation,
    spike: 0,
    priceLevel: 1,
    wageIndex: 1,
    policyRate,
    mortgageRate: eco.rates.mortgageBase + eco.rates.mortgagePolicyWeight * policyRate,
    stockIndex: 1,
    bondIndex: 1,
    housingIndex: 1,
    housingGrowth: regime.housing,
    stockReturn: 0,
    bondReturn: 0,
    housingReturn: 0,
    sectors,
  }
}

export function economyMonth(ctx: Ctx): void {
  const { state, content, rng } = ctx
  const eco = content.bundle.country.economy
  const w = state.world
  const now = state.now
  const lasted = now - w.regimeSince

  // 1. The cycle.
  if (w.regime === 'expansion') {
    if (rng.chance(eco.cycle.recessionBase + eco.cycle.recessionPerMonth * lasted, 'econ.turn', now)) {
      w.regime = rng.chance(eco.cycle.severeShare, 'econ.severe', now) ? 'severe' : 'recession'
      w.regimeSince = now
      w.recessions += 1
    }
  } else if (w.regime === 'recovery') {
    if (lasted >= eco.cycle.recoveryMonths) {
      w.regime = 'expansion'
      w.regimeSince = now
    }
  } else if (lasted >= eco.cycle.recessionMinMonths && rng.chance(w.regime === 'severe' ? eco.cycle.severeEndPerMonth : eco.cycle.recessionEndPerMonth, 'econ.turn', now)) {
    w.regime = 'recovery'
    w.regimeSince = now
  }
  const regime = eco.regimes[w.regime]

  // 2. Unemployment: quick to rise, slow to fall.
  w.unemployment = Math.max(2, approach(w.unemployment, regime.unemployment, eco.unemployment.riseMonths, eco.unemployment.fallMonths) + 0.04 * rng.normal('econ.unemployment', now))

  // 3. Prices.
  const I = eco.inflation
  let core = w.inflation - w.spike
  core += (regime.inflation - core) / I.revertMonths + I.noise * rng.normal('econ.inflation', now)
  w.spike *= dexp(-1 / I.spikeFadeMonths)
  if (rng.chance(I.spikePerMonth, 'econ.spike', now)) w.spike += I.spikeSize[0] + (I.spikeSize[1] - I.spikeSize[0]) * rng.float('econ.spikeSize', now)
  w.inflation = Math.max(-2, core) + w.spike
  w.priceLevel *= 1 + w.inflation / 1200

  // 4. Pay follows prices with a lag and gives ground when jobs are scarce.
  const payTarget = w.priceLevel * (1 + (eco.wages.perPointOfUnemployment * (w.unemployment - eco.wages.neutralUnemployment)) / 100)
  w.wageIndex = approach(w.wageIndex, payTarget, eco.wages.lagMonths, eco.wages.lagMonths)

  // 5. Interest rates.
  const before = w.policyRate
  w.policyRate = approach(w.policyRate, policyTarget(content, w.inflation, w.unemployment), eco.rates.smoothingMonths, eco.rates.smoothingMonths)
  w.mortgageRate = eco.rates.mortgageBase + eco.rates.mortgagePolicyWeight * w.policyRate

  // 6. Shares, with the occasional month far outside the ordinary; bonds; houses.
  const shock = rng.normal('econ.stocks', now) * (rng.chance(eco.stocks.fatTailChance, 'econ.fatTail', now) ? eco.stocks.fatTailScale : 1)
  w.stockReturn = dexp(regime.stockMean + (w.inflation - eco.regimes.expansion.inflation) / 1200 + regime.stockSd * shock) - 1
  w.stockIndex *= 1 + w.stockReturn
  w.bondReturn = (before + eco.rates.bondSpread) / 1200 - (eco.rates.bondDuration * (w.policyRate - before)) / 100
  w.bondIndex *= 1 + w.bondReturn
  w.housingGrowth = eco.housing.momentum * w.housingGrowth + (1 - eco.housing.momentum) * regime.housing + eco.housing.noise * rng.normal('econ.housing', now)
  w.housingReturn = (w.housingGrowth + w.inflation) / 1200
  w.housingIndex *= 1 + w.housingReturn

  // 7. Sectors drift.
  for (const sector of eco.sectors) {
    const s = (w.sectors[sector.id] ??= { index: 1, trend: sector.trend })
    s.trend += (sector.trend - s.trend) / 240 + 0.03 * sector.noise * rng.normal('econ.sectorTrend', sector.id, now)
    s.index *= dexp(s.trend / 1200 + (sector.noise / 100) * rng.normal('econ.sector', sector.id, now))
  }
}

/** How scarce jobs are this month for a line of work: points of unemployment above the reference, scaled. */
export function slack(content: Prepared, world: World, cyclical: number): number {
  return cyclical * (world.unemployment - content.bundle.country.economy.unemployment.reference)
}
