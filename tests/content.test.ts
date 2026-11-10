import { describe, expect, it } from 'vitest'
import { ContentError, compileContent } from '../src/content/compile'
import { contentWith, realContent, realFiles } from './helpers'

const problemsOf = (changes: Record<string, string | null>): string => {
  try {
    contentWith(changes)
    return ''
  } catch (error) {
    if (error instanceof ContentError) return error.problems.join('\n')
    throw error
  }
}

const event = (body: string): Record<string, string> => ({ 'core/events/zz-test.yaml': body })

describe('content', () => {
  it('the shipped content compiles and validates', () => {
    const content = realContent()
    expect(content.bundle.events.length).toBeGreaterThan(5)
    expect(content.bundle.country.lifeTable.male).toHaveLength(100)
    expect(content.bundle.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('the hash changes when any data changes', () => {
    const files = realFiles()
    files['core/pacing.yaml'] = files['core/pacing.yaml']!.replace('midlife: 2', 'midlife: 3')
    expect(compileContent(files).hash).not.toBe(realContent().bundle.hash)
  })

  it('reports the file and field of a schema error', () => {
    expect(problemsOf({ 'core/pacing.yaml': 'maxOptionalDecisionsPerYear: { midlife: "many" }' })).toMatch(/core\/pacing\.yaml: maxOptionalDecisionsPerYear\.midlife/)
    expect(problemsOf({ 'core/stages.yaml': null })).toMatch(/core\/stages\.yaml: file is missing/)
  })

  it('rejects an expression that reads something content may not read', () => {
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true, when: "self.body.cardio > 0.5", effects: [{ setFlag: { name: x, value: 1 } }] }`))).toMatch(/'self\.body\.cardio' is not something content can read/)
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true, when: "secret(1)", effects: [{ setFlag: { name: x, value: 1 } }] }`))).toMatch(/unknown function 'secret'/)
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true, when: "self.age >", effects: [{ setFlag: { name: x, value: 1 } }] }`))).toMatch(/events\.t\.bad when/)
  })

  it('rejects references to things that do not exist', () => {
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true, effects: [{ startProcess: nonexistent }] }`))).toMatch(/unknown process 'nonexistent'/)
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true, effects: [{ adjust: { stock: cardio, delta: -0.1, cause: mystery } }] }`))).toMatch(/cause 'mystery' is not in factors/)
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true, stages: [afterlife], effects: [{ setFlag: { name: x, value: 1 } }] }`))).toMatch(/unknown stage 'afterlife'/)
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true, effects: [{ setPolicy: { activity: levitating } }] }`))).toMatch(/unknown activity level 'levitating'/)
  })

  it('rejects events that would do nothing, never fire, or fire every month', () => {
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true }`))).toMatch(/does nothing/)
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true, when: "false", effects: [{ setFlag: { name: x, value: 1 } }] }`))).toMatch(/can never fire/)
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, effects: [{ setFlag: { name: x, value: 1 } }] }`))).toMatch(/would fire every month/)
  })

  it('requires a source for every base rate', () => {
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, hazard: { base: { perYear: 0.1, population: all } }, effects: [{ setFlag: { name: x, value: 1 } }] }`))).toMatch(/hazard\.base\.source/)
  })

  it('rejects facts with no text and text with no fact', () => {
    expect(problemsOf(event(`- { id: t.bad, sourceClass: chance, once: true, fact: { kind: unheard_of } }`))).toMatch(/no text renders facts of kind 'unheard_of'/)
    expect(problemsOf({ 'core/text/zz-test.yaml': `- { id: t.orphan, fact: never_emitted, variants: [{ text: "x" }] }` })).toMatch(/nothing emits a fact of kind 'never_emitted'/)
  })

  it('rejects text that uses a field its fact does not provide', () => {
    const problems = problemsOf({
      ...event(`- { id: t.ok, sourceClass: chance, once: true, fact: { kind: test_fact, data: { size: 3 } } }`),
      'core/text/zz-test.yaml': `- { id: t.text, fact: test_fact, variants: [{ text: "It was {fact.colour}." }] }`,
    })
    expect(problems).toMatch(/fact 'test_fact' has no field 'colour'/)
  })

  it('rejects a decision whose prompt is missing or conditional', () => {
    const decision = (prompt: string): string => `
- id: t.choice
  sourceClass: chance
  once: true
  decision:
    class: blocking
    prompt: ${prompt}
    options:
      - { id: a, label: A }
      - { id: b, label: B }
`
    expect(problemsOf(event(decision('prompt.missing')))).toMatch(/prompt text 'prompt\.missing' does not exist/)
    expect(problemsOf({ ...event(decision('prompt.cond')), 'core/text/zz-test.yaml': `- { id: prompt.cond, variants: [{ when: "self.age > 3", text: "x" }] }` })).toMatch(/needs at least one variant with no condition/)
  })

  it('accepts new events, processes and text with no engine change', () => {
    const content = contentWith({
      'core/events/zz-test.yaml': `
- id: t.cold
  sourceClass: chance
  cooldownMonths: 6
  hazard: { base: { perYear: 2, population: everyone, source: test, asOf: 2026 } }
  effects: [{ startProcess: cold }]
  fact: { kind: cold_started, data: { month: world.monthName } }
`,
      'core/processes/zz-test.yaml': `
- id: cold
  stages:
    - { id: sniffles, status: Has a cold, duration: { months: [1, 1] } }
`,
      'core/text/zz-test.yaml': `- { id: t.cold, fact: cold_started, variants: [{ text: "A cold in {fact.month}." }] }`,
    })
    expect(content.eventById.has('t.cold')).toBe(true)
    expect(content.processes.has('cold')).toBe(true)
  })
})
