import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SAVE_FORMAT, SCHEMA_VERSION, SaveError, checkInvariants, exportSave, importSave, perceive, stateHash, step, type Migration } from '../src/engine'
import { liveUntil, newLife, realContent, testEnv } from './helpers'

const env = testEnv()
const midLife = liveUntil(newLife('save-1', env, 200), env, (s) => s.now - s.people.p1!.born >= 12 * 40)

describe('saves', () => {
  it('a save round-trips exactly and play continues identically from it', () => {
    const loaded = importSave(exportSave(midLife))
    expect(loaded).toEqual(midLife)
    expect(stateHash(loaded)).toBe(stateHash(midLife))
    expect(checkInvariants(loaded, realContent())).toEqual([])
    const a = step(midLife, { type: 'advance', until: 'birthday' }, env).state
    const b = step(loaded, { type: 'advance', until: 'birthday' }, env).state
    expect(stateHash(b)).toBe(stateHash(a))
  })

  it('says plainly what is wrong with a file it cannot load', () => {
    expect(() => importSave('not json at all')).toThrow(/not valid JSON/)
    expect(() => importSave('{"hello":"world"}')).toThrow(/not a Lifesim save/)
    expect(() => importSave(JSON.stringify({ format: SAVE_FORMAT }))).toThrow(/damaged/)
    expect(() => importSave(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: SCHEMA_VERSION + 1, state: {} }))).toThrow(/newer version of the game/)
    expect(() => importSave(JSON.stringify({ format: SAVE_FORMAT, schemaVersion: 0, state: {} }))).toThrow(/too old to load/)
    expect(() => importSave('nope')).toThrow(SaveError)
  })

  it('rejects a save whose state has been damaged or tampered with', () => {
    const file = JSON.parse(exportSave(midLife))
    file.state.people.p1.body.cardio = 'very'
    expect(() => importSave(JSON.stringify(file))).toThrow(/damaged \(people\.p1\.body\.cardio/)
    const extra = JSON.parse(exportSave(midLife))
    extra.state.unknownField = 1
    expect(() => importSave(JSON.stringify(extra))).toThrow(/damaged/)
  })

  it('upgrades old saves through a chain of migrations, one version at a time', () => {
    // A pretend future: version 3 renames a stock and version 4 adds a field. Each migration moves
    // a save forward exactly one version; the loader runs them in order.
    const migrations: Record<number, Migration> = {
      2: (state) => ({ ...state, renamed: true, meta: { ...(state.meta as object), schemaVersion: 3 } }),
      3: (state) => {
        const { renamed: _renamed, ...rest } = state
        return { ...rest, meta: { ...(state.meta as object), schemaVersion: 2 } }
      },
    }
    const file = exportSave(midLife)
    // Run 2 → 3 → 4, where "4" happens to have today's shape, so the result must validate.
    const upgraded = importSave(file, { migrations, targetVersion: 4 })
    expect(upgraded).toEqual(midLife)
    // With a step missing there is no path, and the loader says so.
    expect(() => importSave(file, { migrations: { 2: migrations[2]! }, targetVersion: 4 })).toThrow(/no upgrade path from save format 3/)
  })

  it('loads a real Milestone 1 save and plays it on to the end', () => {
    const text = readFileSync(fileURLToPath(new URL('./fixtures/save-v1.json', import.meta.url)), 'utf8')
    expect(JSON.parse(text).schemaVersion).toBe(1)
    let state = importSave(text)
    expect(state.meta.schemaVersion).toBe(SCHEMA_VERSION)
    expect(checkInvariants(state, realContent())).toEqual([])
    const before = { name: state.people.p1!.name, born: state.people.p1!.born, cardio: state.people.p1!.body.cardio, log: state.log.length }
    expect(before.name.first).toBe('Ada')
    expect(before.log).toBeGreaterThan(40)

    // The old life has no family and no schooling on record, and the view says so without failing.
    const view = perceive(state, realContent())
    expect(view.family.members).toEqual([])
    expect(view.school.line).toBe('')
    expect(view.routine.study).toBeNull()

    state = liveUntil(state, env, () => false)
    expect(state.phase).toBe('ended')
    expect(state.log.at(-1)!.fact.kind).toBe('obituary')
    expect(state.log.at(-1)!.text).toContain('Ada Rivera')
    expect(checkInvariants(state, realContent())).toEqual([])
  })
})
