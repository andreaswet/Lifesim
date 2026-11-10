/**
 * Batch simulation from the command line.
 *
 *   npm run batch -- --lives 5000 --seed cal1 --strategy persona [--no-text] [--workers 4] [--out reports]
 *
 * Prints a comparison with the calibration targets and writes the full summary as JSON. The
 * result depends only on the seed, the strategy and the number of lives, never on how many
 * workers shared the work.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { CONTENT_DIR, loadContent } from '../content/load-node'
import { prepareContent } from '../engine'
import { createNarrator } from '../narrative'
import { runBatch, summarize, SURVIVAL_AGES, type BatchOptions, type LifeResult } from './batch-lib'
import { STRATEGIES, type Strategy } from './players'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

interface WorkerJob {
  options: BatchOptions
  withText: boolean
}

if (!isMainThread) {
  const job = workerData as WorkerJob
  const content = prepareContent(loadContent())
  parentPort!.postMessage(runBatch(job.options, { content, narrator: job.withText ? createNarrator() : null }))
  process.exit(0)
}

const lives = Number(arg('lives', '2000'))
const seed = arg('seed', 'batch')
const strategy = arg('strategy', 'persona') as Strategy | 'mixed'
if (strategy !== 'mixed' && !STRATEGIES.includes(strategy)) throw new Error(`Unknown strategy '${strategy}'. Use one of: ${STRATEGIES.join(', ')}, mixed`)
const withText = !process.argv.includes('--no-text')
const workers = Math.max(1, Math.min(Number(arg('workers', String(Math.min(8, availableParallelism())))), Math.ceil(lives / 50)))

const content = prepareContent(loadContent())
const started = performance.now()

// Lives are split into contiguous index ranges; the mixed strategy is assigned by index, so each
// life is the same whichever worker runs it.
const share = Math.ceil(lives / workers)
const jobs: Array<Promise<LifeResult[]>> = []
for (let w = 0; w < workers; w++) {
  const from = w * share
  const count = Math.min(share, lives - from)
  if (count <= 0) break
  const job: WorkerJob = { options: { lives: count, seed, strategy, from }, withText }
  jobs.push(
    new Promise((resolve, reject) => {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: job, execArgv: process.execArgv })
      worker.once('message', resolve)
      worker.once('error', reject)
    }),
  )
}
const results = (await Promise.all(jobs)).flat()
const elapsed = performance.now() - started
const s = summarize(results, content, elapsed)

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`
const lines: string[] = []
lines.push(`Batch: ${lives} lives, seed "${seed}", strategy ${strategy}, content ${content.bundle.hash}, text ${withText ? 'on' : 'off'}`)
lines.push(`Time: ${(elapsed / 1000).toFixed(1)} s on ${jobs.length} worker${jobs.length === 1 ? '' : 's'}; ${((s.msPerSimulatedYear * jobs.length)).toFixed(3)} ms of computing per simulated year`)
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
const e = s.schooling
lines.push('')
lines.push('Family and schooling                                 simulated     target')
const row = (label: string, value: string, target: string): void => void lines.push(`  ${label.padEnd(50)} ${value.padStart(8)}     ${target}`)
row('Born to married / cohabiting / lone mother', `${pct(e.birth.married)} ${pct(e.birth.cohabiting)} ${pct(e.birth.apart)}`.replace(/%/g, ''), '60 / 24 / 16 (NCHS, NSFG)')
row('Median household income at birth', '$' + Math.round(e.birth.medianIncome).toLocaleString('en-US'), '')
row('Children under 18 living with both parents', pct(e.childrenWithTwoParents), 'about 65% (Census CPS 2023)')
row('Brothers and sisters (mean)', e.birth.meanSiblings.toFixed(2), 'about 1.8, seen from the child')
row('Mean high-school GPA', e.meanHsGpa.toFixed(2), '3.0–3.1 (NAEP HSTS 2019)')
row('Graduate high school with their class', pct(e.graduatedOnTime), '86–87% (NCES 219.46)')
row('Completed high school by 27', pct(e.completedHighSchoolAt27), '94.3% (NCES 104.20, ages 25–29)')
row('Take the SAT', pct(e.testTakers), '')
row('SAT total, mean (sd)', `${e.meanTestTotal.toFixed(0)} (${e.sdTestTotal.toFixed(0)})`, '1028 (about 215)')
row('Enroll right after high school', pct(e.enrolledRightAway.any), '62.0% (NCES 302.10)')
row('  at a two-year college', pct(e.enrolledRightAway.twoYear), '16.9%')
row('  at a four-year college', pct(e.enrolledRightAway.fourYear), '45.1%')
row('Ever enrolled in college by 27', pct(e.everEnrolledBy27), 'about 84% (NCES ELS:2002, by 26)')
row('Associate degree or higher by 27', pct(e.associateOrHigherAt27), '49.7% (NCES 104.20)')
row("Bachelor's or higher by 27", pct(e.bachelorAt27), '40.5%')
row('  men / women', `${pct(e.bachelorAt27BySex.male)} / ${pct(e.bachelorAt27BySex.female)}`, '35.9% / 45.2%')
row("Bachelor's by family income quarter, poorest first", e.bachelorByIncomeQuarter.map((x) => (100 * x).toFixed(0)).join(' / '), 'about 15 / 28 / 45 / 62 (Pell Institute)')
row('Enrolled right away, by income quarter', e.enrolledByIncomeQuarter.map((x) => (100 * x).toFixed(0)).join(' / '), '')
row('Achievement gap, 90th vs 10th income percentile (SD)', e.achievementGap9010.toFixed(2), '1.0–1.25 (Reardon 2011)')
row('Parent–child schooling correlation', e.parentChildEducationCorrelation.toFixed(2), '0.46 (Hertz et al. 2007)')
row('Four-year entrants with a degree within six years', pct(e.sixYearCompletionFourYear), 'about 70% (NSC; 64.6% at first college, NCES 326.10)')
row('Two-year entrants: associate / transferred / bachelor', `${(100 * e.twoYearEntrants.associate).toFixed(0)} / ${(100 * e.twoYearEntrants.transferred).toFixed(0)} / ${(100 * e.twoYearEntrants.bachelor).toFixed(0)}`, 'about 30 / 33 / 16')
row("Bachelor's graduates who borrowed", pct(e.borrowedAmongBachelors), 'about half (College Board)')
row('Their average debt', '$' + Math.round(e.meanDebtAmongBorrowers).toLocaleString('en-US'), 'about $29,000, private loans included')
lines.push('  Enrollment by kind of college: ' + Object.entries(e.byTier).map(([k, v]) => `${k} ${pct(v)}`).join(', '))
if (process.argv.includes('--write-norms')) {
  const body = (['literacy', 'math'] as const).map((subject) => `${subject}:\n  mean: [${e.norms[subject].mean.join(', ')}]\n  sd: [${e.norms[subject].sd.join(', ')}]`).join('\n')
  writeFileSync(
    join(CONTENT_DIR, 'countries/us/education/norms.yaml'),
    `# National norms: the mean and spread of achievement, in grade equivalents, at the end of each\n# grade (index 0 is kindergarten, 12 is twelfth grade). Produced by\n# \`npm run batch -- --write-norms\`; run it again whenever the learning model changes.\n# A test checks that they are not stale.\nsource: "Simulated population: ${lives} lives, seed ${seed}"\n${body}\n`,
  )
  lines.push('')
  lines.push('Norms written to content/countries/us/education/norms.yaml')
}
if (process.argv.includes('--norms')) {
  lines.push('')
  lines.push('Norms for content/countries/us/education/norms.yaml:')
  for (const subject of ['literacy', 'math'] as const) {
    lines.push(`${subject}:`)
    lines.push(`  mean: [${e.norms[subject].mean.join(', ')}]`)
    lines.push(`  sd: [${e.norms[subject].sd.join(', ')}]`)
  }
}
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
