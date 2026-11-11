import { useRef, useState } from 'preact/hooks'
import type { Setup } from '../app/protocol'
import type { Actions } from './App'

/** A short, readable seed. The seed plus the choices made is the whole life (design §4.3). */
function randomSeed(): string {
  const words = new Uint32Array(2)
  crypto.getRandomValues(words)
  return Array.from(words, (w) => w.toString(36)).join('-')
}

export function Start({ actions, busy, setup }: { actions: Actions; busy: boolean; setup: Setup }) {
  const [firstName, setFirstName] = useState('')
  const [sex, setSex] = useState<'' | 'male' | 'female'>('')
  const [seed, setSeed] = useState('')
  const [place, setPlace] = useState('')
  const [group, setGroup] = useState('')
  const file = useRef<HTMLInputElement>(null)

  const begin = (event: Event): void => {
    event.preventDefault()
    void actions.send({
      type: 'new',
      options: { seed: seed.trim() || randomSeed(), ...(firstName.trim() ? { firstName: firstName.trim() } : {}), ...(sex ? { sex } : {}), ...(place ? { state: place } : {}), ...(group ? { ethnicity: group } : {}) },
    })
  }

  const load = async (): Promise<void> => {
    const chosen = file.current?.files?.[0]
    if (!chosen) return
    await actions.send({ type: 'import', text: await chosen.text() })
    if (file.current) file.current.value = ''
  }

  return (
    <main class="start">
      <h1>Lifesim</h1>
      <p class="lede">One life in the United States, from a birth in 2026 to whenever it ends. You read it a year at a time and make the choices a person gets to make.</p>
      <p class="note">
        This is the third of seven milestones. You are born into a family drawn from the real spread of American births, grow up in it, go through school, and then earn a living: jobs and careers, rent or a mortgage, taxes, debt, savings, the ups and downs of the
        economy, and in the end retirement. Friends and partners do not exist yet. The family you get, like the body, is not chosen: that is the game.
      </p>

      <form onSubmit={begin}>
        <label>
          <span>First name</span>
          <input type="text" value={firstName} onInput={(e) => setFirstName(e.currentTarget.value)} placeholder="Leave empty to be given one" maxLength={30} autocomplete="off" />
        </label>

        <fieldset>
          <legend>Sex at birth</legend>
          {(
            [
              ['', 'Leave it to chance'],
              ['female', 'Female'],
              ['male', 'Male'],
            ] as const
          ).map(([value, label]) => (
            <label class="radio" key={value}>
              <input type="radio" name="sex" checked={sex === value} onChange={() => setSex(value)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>

        <label>
          <span>Born in</span>
          <select value={place} onChange={(e) => setPlace(e.currentTarget.value)}>
            <option value="">Anywhere in the United States, by population</option>
            {setup.states.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Background</span>
          <select value={group} onChange={(e) => setGroup(e.currentTarget.value)}>
            <option value="">Leave it to chance, as births fall</option>
            {setup.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
          <small>Race and ethnicity shape the family you are born into, and a few documented things later on. "Why?" says so where it matters.</small>
        </label>

        <label>
          <span>Seed</span>
          <input type="text" value={seed} onInput={(e) => setSeed(e.currentTarget.value)} placeholder="Leave empty for a new one" maxLength={40} autocomplete="off" />
          <small>The same seed and the same choices always give the same life.</small>
        </label>

        <button type="submit" class="primary" disabled={busy}>
          Begin a life
        </button>
      </form>

      <div class="load">
        <label class="filebutton">
          <input ref={file} type="file" accept="application/json,.json" onChange={() => void load()} />
          <span>Load a saved life…</span>
        </label>
      </div>
    </main>
  )
}
