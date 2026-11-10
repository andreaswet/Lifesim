import type { RefObject } from 'preact'
import { useRef, useState } from 'preact/hooks'
import type { ActionView, PlayerView, PolicyView } from '../app/protocol'
import type { Actions } from './App'
import { Why } from './Game'

function Policy({ name, title, policy, busy, onChoose }: { name: string; title: string; policy: PolicyView; busy: boolean; onChoose: (id: string) => void }) {
  return (
    <>
      <h3>{title}</h3>
      {policy.lockedReason && <p class="locked">{policy.lockedReason}</p>}
      <div class="choices" role="radiogroup" aria-label={title}>
        {policy.options.map((option) => (
          <label key={option.id} class={option.id === policy.current ? 'choice current' : 'choice'}>
            <input type="radio" name={name} checked={option.id === policy.current} disabled={!policy.canChange || busy} onChange={() => onChoose(option.id)} />
            <span class="label">{option.label}</span>
            <span class="costs">{option.hoursPerWeek === 0 ? 'no time' : `${option.hoursPerWeek} hour${option.hoursPerWeek === 1 ? '' : 's'} a week`}</span>
            <span class="desc">{option.description}</span>
          </label>
        ))}
      </div>
    </>
  )
}

export function RoutinePanel({ view, actions, busy }: { view: PlayerView; actions: Actions; busy: boolean }) {
  if (view.phase !== 'alive') return null
  const set = (policy: { activity?: string; study?: string }): void => void actions.send({ type: 'command', command: { type: 'setPolicy', policy } })
  return (
    <section class="card">
      <h2>Routine</h2>
      <p class="sub">Where your hours go, week in and week out. Everything follows slowly, and there are only so many hours: you are {view.status.strain}.</p>
      {view.routine.study && <Policy name="study" title="Schoolwork" policy={view.routine.study} busy={busy} onChoose={(study) => set({ study })} />}
      <Policy name="activity" title="Exercise" policy={view.routine.activity} busy={busy} onChoose={(activity) => set({ activity })} />
    </section>
  )
}

export function FamilyPanel({ view, compact }: { view: PlayerView; compact: boolean }) {
  const members = compact ? view.family.members.filter((m) => m.notes.includes('lives with you')) : view.family.members
  if (view.family.members.length === 0) return null
  return (
    <section class="card">
      <h2>{compact ? 'At home' : 'Family'}</h2>
      {view.phase === 'alive' && <p class="sub">{view.family.money}</p>}
      {members.length === 0 ? (
        <p class="sub">Nobody from your family lives with you.</p>
      ) : (
        <ul class="people">
          {members.map((m) => (
            <li key={m.id}>
              <span class="who">
                <strong>{m.name}</strong>, your {m.relation}
              </span>
              <span class="meta">{[m.age, ...m.notes.filter((n) => !compact || n !== 'lives with you')].join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ActionButton({ action, actions, busy }: { action: ActionView; actions: Actions; busy: boolean }) {
  const [open, setOpen] = useState(false)
  const run = (choice?: string): void => {
    setOpen(false)
    void actions.send({ type: 'command', command: { type: 'act', action: action.id, ...(choice ? { choice } : {}) } })
  }
  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)}>
        {action.label}
        {action.costs.length > 0 && <span class="costs">{action.costs.join(' · ')}</span>}
      </button>
    )
  }
  return (
    <div class="confirm">
      <p>{action.label}{action.choices.length > 0 ? ':' : '?'}</p>
      <div class="row">
        {action.choices.length > 0 ? (
          action.choices.map((c) => (
            <button key={c.id} type="button" disabled={busy} onClick={() => run(c.id)}>
              {c.label}
            </button>
          ))
        ) : (
          <button type="button" class="primary" disabled={busy} onClick={() => run()}>
            Yes
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)}>
          Not now
        </button>
      </div>
    </div>
  )
}

export function SchoolPanel({ view, actions, busy, compact }: { view: PlayerView; actions: Actions; busy: boolean; compact: boolean }) {
  const school = view.school
  const mine = view.actions.filter((a) => a.section === 'school')
  const empty = !school.line && !school.reportCard && school.facts.length === 0 && mine.length === 0
  if (empty && (compact || !school.attained)) return null
  return (
    <section class="card">
      <h2>School</h2>
      {school.line ? <p class="lead">{school.line}</p> : school.attained && <p class="sub">{school.attained}. Not enrolled.</p>}
      {school.reportCard && (
        <div class="report">
          <h3>{school.reportCard.title}</h3>
          <dl class="record">
            {school.reportCard.subjects.map((s) => (
              <div key={s.label}>
                <dt>{s.label}</dt>
                <dd>{s.letter}</dd>
              </div>
            ))}
            <div>
              <dt>Average</dt>
              <dd>{school.reportCard.gpa}</dd>
            </div>
          </dl>
        </div>
      )}
      {school.facts.length > 0 && (
        <dl class="record">
          {school.facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!compact && mine.length > 0 && (
        <div class="acts">
          {mine.map((a) => (
            <ActionButton key={a.id} action={a} actions={actions} busy={busy} />
          ))}
        </div>
      )}
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
