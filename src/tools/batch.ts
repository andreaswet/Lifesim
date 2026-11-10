/**
 * Batch simulation from the command line.
 *
 *   npm run batch -- --lives 5000 --seed cal1 --strategy persona [--no-text] [--out reports]
 *
 * Prints a comparison with the calibration targets and writes the full summary as JSON.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadContent } from '../content/load-node'
import { prepareContent } from '../engine'
import { createNarrator } from '../narrative'
import { runBatch, summarize, SURVIVAL_AGES } from './batch-lib'
import { STRATEGIES, type Strategy } from './players'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const lives = Number(arg('lives', '2000'))
const seed = arg('seed', 'batch')
const strategy = arg('strategy', 'persona') as Strategy | 'mixed'
if (strategy !== 'mixed' && !STRATEGIES.includes(strategy)) throw new Error(`Unknown strategy '${strategy}'. Use one of: ${STRATEGIES.join(', ')}, mixed`)
const withText = !process.argv.includes('--no-text')

const content = prepareContent(loadContent())
const started = performance.now()
const results = runBatch({ lives, seed, strategy }, { content, narrator: withText ? createNarrator() : null })
const elapsed = performance.now() - started
const s = summarize(results, content, elapsed)

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`
const lines: string[] = []
lines.push(`Batch: ${lives} lives, seed "${seed}", strategy ${strategy}, content ${content.bundle.hash}, text ${withText ? 'on' : 'off'}`)
lines.push(`Time: ${(elapsed / 1000).toFixed(1)} s, ${s.msPerSimulatedYear.toFixed(3)} ms per simulated year`)
lines.push('')
lines.push('Life expectancy at birth (years)        simulated ± SE     life table')
for (const sex of ['male', 'female'] as const) {
  const g = s.bySex[sex]
  lines.push(`  ${sex.padEnd(8)} n=${String(g.lives).padEnd(7)}            ${g.lifeExpectancy.toFixed(2)} ± ${g.standardError.toFixed(2)}      ${g.target.toFixed(2)}`)
}
lines.push('')
lines.push('Survival from birth                     male sim / table        female sim / table')
for (const age of SURVIVAL_AGES) {
  const m = s.bySex.male.survival[age]!
  const f = s.bySex.female.survival[age]!
  lines.push(`  to ${String(age).padEnd(4)}                              ${pct(m.simulated).padStart(6)} / ${pct(m.target).padStart(6)}        ${pct(f.simulated).padStart(6)} / ${pct(f.target).padStart(6)}`)
}
lines.push('')
lines.push(`Boys among births: ${pct(s.maleShare)}`)
lines.push(`Infant mortality per 1,000: ${s.infantMortalityPer1000.simulated.toFixed(1)} (table ${s.infantMortalityPer1000.target.toFixed(1)})`)
lines.push(`Flu per person-year: ${s.fluPerPersonYear.toFixed(4)} (declared base rate 0.0800)`)
lines.push('')
lines.push('Decisions opened per year, by stage: ' + Object.entries(s.decisionsPerYearByStage).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', '))
lines.push('Significant feed items by source: ' + Object.entries(s.significantSourceShares).map(([k, v]) => `${k} ${pct(v)}`).join(', '))
lines.push('Cardio at 60 by activity level: ' + Object.entries(s.cardioAt60ByActivity).map(([k, v]) => `${k} ${v.mean.toFixed(3)} (n=${v.lives})`).join(', '))
if (withText) {
  lines.push('')
  lines.push(`Text: ${s.text.feedLinesPerLife.toFixed(0)} feed lines per life, ${s.text.distinctVariantsUsed} distinct variants used`)
  lines.push(`  lives in which some variant appeared more than twice: ${pct(s.text.livesWithAVariantOverTwice)}`)
  for (const v of s.text.mostUsed) lines.push(`  ${v.variant.padEnd(28)} ${v.perLife.toFixed(2)} per life, at most ${v.maxInOneLife} in one life`)
}
lines.push('')
lines.push(s.invariantProblems.length === 0 ? 'Invariants: none broken' : `Invariants BROKEN:\n  ${s.invariantProblems.join('\n  ')}`)
console.log(lines.join('\n'))

const out = arg('out', 'reports')
mkdirSync(out, { recursive: true })
const file = join(out, `batch-${seed}-${strategy}-${lives}.json`)
writeFileSync(file, JSON.stringify({ options: { lives, seed, strategy, withText }, contentHash: content.bundle.hash, summary: s }, null, 2))
console.log(`\nSummary written to ${file}`)
if (s.invariantProblems.length > 0) process.exit(1)
