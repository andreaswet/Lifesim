import { useRef, useState } from 'preact/hooks'
import type { Actions } from './App'

/** A short, readable seed. The seed plus the choices made is the whole life (design §4.3). */
function randomSeed(): string {
  const words = new Uint32Array(2)
  crypto.getRandomValues(words)
  return Array.from(words, (w) => w.toString(36)).join('-')
}

export function Start({ actions, busy }: { actions: Actions; busy: boolean }) {
  const [firstName, setFirstName] = useState('')
  const [sex, setSex] = useState<'' | 'male' | 'female'>('')
  const [seed, setSeed] = useState('')
  const file = useRef<HTMLInputElement>(null)

  const begin = (event: Event): void => {
    event.preventDefault()
    void actions.send({
      type: 'new',
      options: { seed: seed.trim() || randomSeed(), ...(firstName.trim() ? { firstName: firstName.trim() } : {}), ...(sex ? { sex } : {}) },
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
        This is the first milestone: time, aging and mortality work, and almost nothing else exists yet. There is no family, school, work or money. What happens to the body follows from how active you choose to be; when life ends follows the real US life
        table.
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
