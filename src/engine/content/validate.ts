/**
 * Semantic checks on a content bundle, beyond what the schemas can express: every reference
 * resolves, every expression reads only declared accessors, every text can be rendered from the
 * fact it is attached to (design §12.1).
 */

import { compileExpr, compileTemplate, type Expr } from '../core/expr'
import { COMPOSED_FACTS, ENGINE_FACTS, REQUIRED_TEXT_IDS } from '../facts'
import '../country' // registers each country's hooks, actions and decisions
import { hookNames } from '../systems/actions'
import { DESCRIPTOR_VALUES } from '../systems/perception'
import { ACCESSOR_PATHS, FUNCTION_NAMES } from '../views'
import { STOCK_IDS, type ContentBundle, type Effect, type FactSpec } from './schema'

type Scope = 'base' | 'process' | 'fact'

export function validateContent(bundle: ContentBundle): string[] {
  const problems: string[] = []
  const fail = (where: string, message: string): void => {
    problems.push(`${where}: ${message}`)
  }

  const unique = (where: string, ids: string[]): void => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) fail(where, `duplicate id '${id}'`)
      seen.add(id)
    }
  }

  const stageIds = new Set(bundle.stages.map((s) => s.id))
  const factorIds = new Set(bundle.factors.map((f) => f.id))
  const processIds = new Set(bundle.processes.map((p) => p.id))
  const textIds = new Set(bundle.text.map((t) => t.id))
  const activityIds = new Set(bundle.body.activityLevels.map((a) => a.id))
  const studyIds = new Set(bundle.country.education.k12.study.levels.map((l) => l.id))

  // Fields provided by each fact kind, gathered from the engine and from every content emitter.
  const factFields = new Map<string, Set<string>>()
  for (const [kind, fields] of Object.entries(ENGINE_FACTS)) factFields.set(kind, new Set(fields))
  const declareFact = (fact: FactSpec, extra: string[] = []): void => {
    const fields = factFields.get(fact.kind) ?? new Set<string>()
    for (const key of [...Object.keys(fact.data), ...extra]) fields.add(key)
    factFields.set(fact.kind, fields)
  }

  const checkExpr = (where: string, source: string, scopes: Scope[], factKind?: string): void => {
    let expr: Expr
    try {
      expr = compileExpr(source)
    } catch (error) {
      fail(where, (error as Error).message)
      return
    }
    const allowed = scopes.flatMap((s) => ACCESSOR_PATHS[s])
    for (const path of expr.paths) {
      const ok = allowed.some((a) => (a.endsWith('.*') ? path === a.slice(0, -2) || path.startsWith(a.slice(0, -1)) : a === path || a.startsWith(path + '.')))
      if (!ok) fail(where, `'${path}' is not something content can read (in: ${source})`)
      if (factKind && path.startsWith('fact.')) {
        const field = path.split('.')[1]!
        if (!factFields.get(factKind)?.has(field)) fail(where, `fact '${factKind}' has no field '${field}' (in: ${source})`)
      }
    }
    for (const call of expr.calls) {
      if (!FUNCTION_NAMES.includes(call)) fail(where, `unknown function '${call}' (in: ${source})`)
    }
  }

  const checkTemplate = (where: string, source: string, scopes: Scope[], factKind?: string): void => {
    try {
      for (const part of compileTemplate(source).parts) if (typeof part !== 'string') checkExpr(where, part.source, scopes, factKind)
    } catch (error) {
      fail(where, (error as Error).message)
    }
  }

  const checkFact = (where: string, fact: FactSpec, scopes: Scope[]): void => {
    for (const [key, source] of Object.entries(fact.data)) checkExpr(`${where} fact.${key}`, source, scopes)
  }

  const checkEffects = (where: string, effects: Effect[], scopes: Scope[]): void => {
    for (const effect of effects) {
      if ('adjust' in effect) {
        checkExpr(where, effect.adjust.delta, scopes)
        if (!factorIds.has(effect.adjust.cause)) fail(where, `cause '${effect.adjust.cause}' is not in factors`)
      } else if ('setPolicy' in effect) {
        const { activity, study, effort, search, lifestyle, saving } = effect.setPolicy
        const country = bundle.country
        if (activity !== undefined && !activityIds.has(activity)) fail(where, `unknown activity level '${activity}'`)
        if (study !== undefined && !studyIds.has(study)) fail(where, `unknown study level '${study}'`)
        if (effort !== undefined && !country.labor.performance.levels.some((l) => l.id === effort)) fail(where, `unknown effort level '${effort}'`)
        if (search !== undefined && !country.labor.search.levels.some((l) => l.id === search)) fail(where, `unknown search level '${search}'`)
        if (lifestyle !== undefined && !country.money.living.levels.some((l) => l.id === lifestyle)) fail(where, `unknown lifestyle level '${lifestyle}'`)
        if (saving !== undefined && !country.money.saving.levels.some((l) => l.id === saving)) fail(where, `unknown saving level '${saving}'`)
      } else if ('setFlag' in effect) {
        checkExpr(where, effect.setFlag.value, scopes)
      } else if ('startProcess' in effect) {
        if (!processIds.has(effect.startProcess)) fail(where, `unknown process '${effect.startProcess}'`)
      } else if ('run' in effect) {
        if (!hookNames().includes(effect.run)) fail(where, `unknown hook '${effect.run}'`)
      } else {
        checkFact(where, effect.emit, scopes)
      }
    }
  }

  const collectFacts = (effects: Effect[]): void => {
    for (const effect of effects) if ('emit' in effect) declareFact(effect.emit)
  }

  // First pass: learn every fact kind content can emit.
  for (const event of bundle.events) {
    if (event.fact) declareFact(event.fact)
    collectFacts(event.effects)
    for (const option of event.decision?.options ?? []) {
      if (option.fact) declareFact(option.fact, ['lapsed'])
      collectFacts(option.effects)
    }
  }
  for (const process of bundle.processes) {
    for (const stage of process.stages) {
      collectFacts([...stage.onEnter, ...stage.monthly, ...stage.onExit])
      for (const signal of stage.signals) declareFact(signal.fact)
    }
  }

  // Stages
  unique('stages', bundle.stages.map((s) => s.id))
  if (!bundle.stages.some((s) => s.fromAge === 0)) fail('stages', 'no stage starts at age 0')

  // Body
  for (const stock of STOCK_IDS) {
    const def = bundle.body.stocks[stock]
    if (!def) {
      fail('body', `no definition for stock '${stock}'`)
      continue
    }
    for (let i = 1; i < def.envelope.length; i++) {
      if (def.envelope[i]![0] <= def.envelope[i - 1]![0]) fail(`body.stocks.${stock}`, 'envelope ages must increase')
    }
    if (def.envelope.some(([, v]) => v <= 0 || v > 1)) fail(`body.stocks.${stock}`, 'envelope values must be in (0, 1]')
  }
  unique('body.activityLevels', bundle.body.activityLevels.map((a) => a.id))
  if (!activityIds.has(bundle.body.defaultActivity)) fail('body', `defaultActivity '${bundle.body.defaultActivity}' is not an activity level`)
  for (const level of bundle.body.activityLevels) {
    if (!factorIds.has(`activity.${level.id}`)) fail('body.activityLevels', `factors needs an entry 'activity.${level.id}'`)
    for (const stock of STOCK_IDS) if (level.sustains[stock] === undefined) fail(`body.activityLevels.${level.id}`, `no 'sustains' value for ${stock}`)
  }
  for (const needed of ['growing', 'aging']) if (!factorIds.has(needed)) fail('factors', `missing required factor '${needed}'`)
  unique('factors', bundle.factors.map((f) => f.id))

  // Pacing
  for (const stage of Object.keys(bundle.pacing.maxOptionalDecisionsPerYear)) {
    if (!stageIds.has(stage)) fail('pacing', `unknown stage '${stage}'`)
  }

  // Descriptors
  unique('descriptors', bundle.descriptors.map((d) => d.id))
  for (const d of bundle.descriptors) {
    if (!DESCRIPTOR_VALUES[d.id]) fail(`descriptors.${d.id}`, 'the engine has no value for this descriptor')
    unique(`descriptors.${d.id}`, d.bands.map((b) => b.id))
    d.bands.forEach((band, i) => {
      const last = i === d.bands.length - 1
      if (!last && band.upTo === undefined) fail(`descriptors.${d.id}`, `band '${band.id}' needs an upTo value`)
      if (i > 0 && band.upTo !== undefined && band.upTo <= (d.bands[i - 1]!.upTo ?? -Infinity)) fail(`descriptors.${d.id}`, 'bands must be in ascending order')
    })
  }

  // Events
  unique('events', bundle.events.map((e) => e.id))
  for (const event of bundle.events) {
    const where = `events.${event.id}`
    for (const stage of event.stages ?? []) if (!stageIds.has(stage)) fail(where, `unknown stage '${stage}'`)
    checkExpr(`${where} when`, event.when, ['base'])
    if (event.when.trim() === 'false') fail(where, 'can never fire')
    if (!event.fact && !event.decision && event.effects.length === 0) fail(where, 'does nothing: no effects, fact or decision')
    if (!event.hazard && !event.once && event.cooldownMonths === 0) fail(where, 'has no hazard, is not once-only and has no cooldown, so it would fire every month')
    if (event.optional && !event.decision) fail(where, 'is optional but offers no decision')
    for (const factor of event.hazard?.factors ?? []) {
      if (!factorIds.has(factor.id)) fail(where, `hazard factor '${factor.id}' is not in factors`)
      checkExpr(`${where} factor ${factor.id}`, factor.value, ['base'])
      if (factor.when !== undefined) checkExpr(`${where} factor ${factor.id}`, factor.when, ['base'])
    }
    checkEffects(where, event.effects, ['base'])
    if (event.fact) checkFact(where, event.fact, ['base'])
    if (event.decision) {
      if (!textIds.has(event.decision.prompt)) fail(where, `prompt text '${event.decision.prompt}' does not exist`)
      unique(`${where} options`, event.decision.options.map((o) => o.id))
      for (const option of event.decision.options) {
        checkTemplate(`${where} option ${option.id}`, option.label, ['base'])
        checkExpr(`${where} option ${option.id}`, option.autoWeight, ['base'])
        checkEffects(`${where} option ${option.id}`, option.effects, ['base'])
        if (option.fact) checkFact(`${where} option ${option.id}`, option.fact, ['base'])
      }
    }
  }

  // Processes
  unique('processes', bundle.processes.map((p) => p.id))
  for (const process of bundle.processes) {
    const ids = new Set(process.stages.map((s) => s.id))
    unique(`processes.${process.id}`, process.stages.map((s) => s.id))
    for (const stage of process.stages) {
      const where = `processes.${process.id}.${stage.id}`
      if (stage.duration.months[0] > stage.duration.months[1]) fail(where, 'duration minimum is above its maximum')
      if (stage.next !== 'end' && !ids.has(stage.next)) fail(where, `next stage '${stage.next}' does not exist`)
      checkEffects(where, [...stage.onEnter, ...stage.monthly, ...stage.onExit], ['base', 'process'])
      for (const signal of stage.signals) {
        checkExpr(`${where} signal ${signal.id}`, signal.notice, ['base', 'process'])
        checkFact(`${where} signal ${signal.id}`, signal.fact, ['base', 'process'])
      }
      for (const transition of stage.transitions) {
        if (transition.to !== 'end' && !ids.has(transition.to)) fail(where, `transition to unknown stage '${transition.to}'`)
        if (transition.when !== undefined) checkExpr(where, transition.when, ['base', 'process'])
        if (transition.hazard !== undefined) checkExpr(where, transition.hazard, ['base', 'process'])
      }
    }
  }

  // Text
  const promptIds = new Set(bundle.events.flatMap((e) => (e.decision ? [e.decision.prompt] : [])))
  unique('text', bundle.text.map((t) => t.id))
  const narrated = new Set<string>()
  for (const text of bundle.text) {
    const where = `text.${text.id}`
    const kind = text.fact
    if (kind !== undefined) {
      narrated.add(kind)
      if (!factFields.has(kind)) fail(where, `nothing emits a fact of kind '${kind}'`)
    }
    // Texts fetched by id are rendered with whatever data the caller passes, so their fact fields
    // cannot be checked here; texts bound to a fact kind are checked field by field.
    checkExpr(`${where} when`, text.when, ['base', 'fact'], kind)
    for (const variant of text.variants) {
      if (variant.when !== undefined) checkExpr(where, variant.when, ['base', 'fact'], kind)
      checkTemplate(where, variant.text, ['base', 'fact'], kind)
    }
    if (promptIds.has(text.id) && !(text.when.trim() === 'true' && text.variants.some((v) => v.when === undefined))) {
      fail(where, 'presents a decision, so it needs at least one variant with no condition')
    }
  }
  for (const id of REQUIRED_TEXT_IDS) if (!textIds.has(id)) fail('text', `the narrator needs a text with id '${id}'`)
  for (const kind of factFields.keys()) {
    if (!narrated.has(kind) && !COMPOSED_FACTS.has(kind)) fail('text', `no text renders facts of kind '${kind}'`)
  }

  // Country
  const table = bundle.country.lifeTable
  if (table.male.length !== table.female.length) fail('country.lifeTable', 'male and female columns differ in length')
  if (table.maxAge < table.male.length) fail('country.lifeTable', 'maxAge is below the last listed age')

  // The labor market: every occupation belongs to a sector, can be reached, and names real majors.
  const { labor, economy, money, people, education } = bundle.country
  const sectorIds = new Set(economy.sectors.map((s) => s.id))
  const majorIds = new Set(education.majors.map((m) => m.id))
  const programCredentials = new Set(labor.programs.map((p) => p.credential))
  unique('labor.occupations', labor.occupations.map((o) => o.id))
  unique('labor.programs', labor.programs.map((p) => p.id))
  unique('economy.sectors', economy.sectors.map((s) => s.id))
  for (const occ of labor.occupations) {
    const where = `labor.occupations.${occ.id}`
    if (!sectorIds.has(occ.sector)) fail(where, `unknown sector '${occ.sector}'`)
    if (!labor.employers.names.bySector[occ.sector]) fail(where, `no employer names for sector '${occ.sector}'`)
    for (const major of occ.majors ?? []) if (!majorIds.has(major)) fail(where, `unknown major '${major}'`)
    if (occ.credential && !occ.trainee && !programCredentials.has(occ.credential) && !Object.values(labor.degreeCredentials).includes(occ.credential)) fail(where, `nothing awards the credential '${occ.credential}'`)
  }
  for (const program of labor.programs) for (const major of program.majors ?? []) if (!majorIds.has(major)) fail(`labor.programs.${program.id}`, `unknown major '${major}'`)
  for (const major of Object.keys(labor.degreeCredentials)) if (!majorIds.has(major)) fail('labor.degreeCredentials', `unknown major '${major}'`)
  for (let i = 1; i < labor.ladder.length; i++) if (labor.ladder[i]!.months < labor.ladder[i - 1]!.months) fail('labor.ladder', 'rungs must be in ascending order')
  for (const [key, levels, chosen] of [
    ['labor.performance', labor.performance.levels, labor.performance.default],
    ['labor.search', labor.search.levels, labor.search.default],
    ['money.living', money.living.levels, money.living.default],
    ['money.saving', money.saving.levels, money.saving.default],
  ] as const) {
    unique(key, levels.map((l) => l.id))
    if (!levels.some((l) => l.id === chosen)) fail(key, `default '${chosen}' is not one of its levels`)
  }
  unique('people.groups', people.groups.map((g) => g.id))
  const births = people.groups.reduce((a, g) => a + g.share, 0)
  if (Math.abs(births - 1) > 0.01) fail('people.groups', `shares of births sum to ${births.toFixed(3)}, not 1`)
  for (const group of [...Object.keys(labor.search.callbacks.byGroup), ...Object.keys(money.housing.approval.byGroup)]) {
    if (!people.groups.some((g) => g.id === group)) fail('people', `a documented effect names an unknown group '${group}'`)
  }
  for (const id of ['job_market', 'job_sector', 'job_experience', 'job_first', 'job_gap', 'job_age', 'job_interview', 'job_fit', 'job_callbacks', 'loan_credit', 'loan_burden', 'loan_down', 'loan_group', 'adm_college_record']) {
    if (!factorIds.has(id)) fail('factors', `missing required factor '${id}'`)
  }

  return problems
}
