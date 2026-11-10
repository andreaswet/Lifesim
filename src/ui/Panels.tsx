import type { RefObject } from 'preact'
import { useRef, useState } from 'preact/hooks'
import type { PlayerView } from '../app/protocol'
import type { Actions } from './App'
import { Why } from './Game'

export function RoutinePanel({ view, actions, busy }: { view: PlayerView; actions: Actions; busy: boolean }) {
  const activity = view.routine.activity
  if (view.phase !== 'alive') return null
  return (
    <section class="card">
      <h2>Routine</h2>
      <p class="sub">How much you move, week in and week out. The body follows slowly: months to build, weeks to lose.</p>
      {activity.lockedReason && <p class="locked">{activity.lockedReason}</p>}
      <div class="choices" role="radiogroup" aria-label="Activity">
        {activity.options.map((option) => (
          <label key={option.id} class={option.id === activity.current ? 'choice current' : 'choice'}>
            <input
              type="radio"
              name="activity"
              checked={option.id === activity.current}
              disabled={!activity.canChange || busy}
              onChange={() => void actions.send({ type: 'command', command: { type: 'setPolicy', policy: { activity: option.id } } })}
            />
            <span class="label">{option.label}</span>
            <span class="costs">{option.hoursPerWeek === 0 ? 'no time' : `${option.hoursPerWeek} hours a week`}</span>
            <span class="desc">{option.description}</span>
          </label>
        ))}
      </div>
    </section>
  )
}

export function HealthPanel({ view }: { view: PlayerView }) {
  if (view.phase !== 'alive') return null
  return (
    <section class="card">
      <h2>Health</h2>
      <p class="sub">How you feel in yourself. A gut feeling, not a measurement.</p>
      <ul class="plain">
        {view.status.conditions.map((c) => (
          <li key={c}>
            <strong>{c}.</strong>
          </li>
        ))}
        <li>You are {view.status.health}.</li>
        <li>You are {view.status.fitness}.</li>
        <li>You are {view.status.strength}.</li>
      </ul>
    </section>
  )
}

export function LogPanel({ view, actions, searchRef }: { view: PlayerView; actions: Actions; searchRef: RefObject<HTMLInputElement | null> }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const entries = view.feed.filter((item) => item.kind !== 'year_summary' && (!q || item.text.toLowerCase().includes(q) || item.dateText.toLowerCase().includes(q)))
  return (
    <section class="card">
      <h2>Life log</h2>
      <label class="search">
        <span>Search</span>
        <input ref={searchRef} type="search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} placeholder="A word, a month, a year" />
      </label>
      <p class="sub">
        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
        {q ? ` matching “${query.trim()}”` : ''}
      </p>
      <ol class="log">
        {[...entries].reverse().map((item) => (
          <li key={item.id}>
            <time>
              {item.dateText} · age {item.age}
            </time>
            <p>{item.text}</p>
            {item.whyId && <Why outcomeId={item.whyId} actions={actions} />}
          </li>
        ))}
      </ol>
    </section>
  )
}

export function SavesPanel({ view, actions }: { view: PlayerView; actions: Actions }) {
  const file = useRef<HTMLInputElement>(null)
  const [confirming, setConfirming] = useState(false)

  const download = async (): Promise<void> => {
    const text = await actions.exportSave()
    if (!text) return
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `lifesim-${view.person.firstName.toLowerCase()}-age-${view.person.age}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const load = async (): Promise<void> => {
    const chosen = file.current?.files?.[0]
    if (!chosen) return
    await actions.send({ type: 'import', text: await chosen.text() })
    if (file.current) file.current.value = ''
  }

  return (
    <section class="card">
      <h2>Saves</h2>
      <p class="sub">The game saves itself in this browser after every step. A save file lets you keep a life, or move it to another device.</p>
      <div class="row">
        <button type="button" onClick={() => void download()}>
          Download save file
        </button>
        <label class="filebutton">
          <input ref={file} type="file" accept="application/json,.json" onChange={() => void load()} />
          <span>Load a save file…</span>
        </label>
      </div>
      <p class="seed">
        Seed: <code>{view.seed}</code>
      </p>
      <div class="row">
        {confirming ? (
          <>
            <span>End this life and start over? The autosave will be erased.</span>
            <button type="button" class="danger" onClick={() => void actions.send({ type: 'abandon' })}>
              Yes, start over
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Keep playing
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            Start a new life…
          </button>
        )}
      </div>
    </section>
  )
}
