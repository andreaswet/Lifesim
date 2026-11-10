import { describe, expect, it } from 'vitest'
import { SAVE_FORMAT, SCHEMA_VERSION, SaveError, checkInvariants, exportSave, importSave, stateHash, step, type Migration } from '../src/engine'
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

  it('upgrades old saves through the chain of migrations', () => {
    // A pretend history: version -1 called the stock "stamina" and had no flags; version 0 had
    // no perception record. Each migration moves a save forward exactly one version.
    const migrations: Record<number, Migration> = {
      [-1]: (state) => {
        const people = state.people as Record<string, { body: Record<string, number>; flags?: unknown }>
        for (const p of Object.values(people)) {
          p.body.cardio = p.body.stamina!
          delete p.body.stamina
          p.flags = {}
        }
        return { ...state, meta: { ...(state.meta as object), schemaVersion: 0 } }
      },
      0: (state) => ({ ...state, perception: {}, meta: { ...(state.meta as object), schemaVersion: 1 } }),
    }
    const old = JSON.parse(exportSave(midLife))
    old.schemaVersion = -1
    old.state.meta.schemaVersion = -1
    old.state.people.p1.body.stamina = old.state.people.p1.body.cardio
    delete old.state.people.p1.body.cardio
    delete old.state.people.p1.flags
    delete old.state.perception

    const upgraded = importSave(JSON.stringify(old), { migrations })
    expect(upgraded.people.p1!.body.cardio).toBe(midLife.people.p1!.body.cardio)
    expect(upgraded.meta.schemaVersion).toBe(SCHEMA_VERSION)
    expect(checkInvariants(upgraded, realContent())).toEqual([])
    // Without the first migration there is no path, and the loader says so.
    expect(() => importSave(JSON.stringify(old), { migrations: { 0: migrations[0]! } })).toThrow(/no upgrade path from save format -1/)
  })
})
