import { useEffect, useRef, useState } from 'preact/hooks'
import type { DecisionView, Explanation, FeedItem, PlayerView } from '../app/protocol'
import type { Actions } from './App'
import { FamilyPanel, HealthPanel, LogPanel, RoutinePanel, SavesPanel, SchoolPanel } from './Panels'

const TABS = [
  { id: 'story', label: 'Story', key: 't' },
  { id: 'family', label: 'Family', key: 'f' },
  { id: 'school', label: 'School', key: 'c' },
  { id: 'routine', label: 'Routine', key: 'r' },
  { id: 'health', label: 'Health', key: 'h' },
  { id: 'log', label: 'Life log', key: 'l' },
  { id: 'saves', label: 'Saves', key: 'v' },
] as const
type TabId = (typeof TABS)[number]['id']

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function Why({ outcomeId, actions }: { outcomeId: string; actions: Actions }) {
  const [answer, setAnswer] = useState<Explanation | null>(null)
  const [open, setOpen] = useState(false)
  const toggle = async (): Promise<void> => {
    if (!open && !answer) setAnswer(await actions.explain(outcomeId))
    setOpen(!open)
  }
  return (
    <>
      <button type="button" class="why" aria-expanded={open} data-why onClick={() => void toggle()}>
        Why?
      </button>
      {open && answer && (
        <div class="because">
          {answer.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </>
  )
}

function Decision({ decision, actions, busy }: { decision: DecisionView; actions: Actions; busy: boolean }) {
  return (
    <div class="decision" role="group" aria-label="A decision">
      <p class="prompt">{decision.prompt}</p>
      <ol class="options">
        {decision.options.map((option, i) => (
          <li key={option.id}>
            <button type="button" disabled={busy} onClick={() => void actions.send({ type: 'command', command: { type: 'decide', decisionId: decision.id, optionId: option.id } })}>
              <kbd>{i + 1}</kbd>
              <span class="label">{option.label}</span>
              {option.costs.length > 0 && <span class="costs">{option.costs.join(' · ')}</span>}
            </button>
          </li>
        ))}
      </ol>
      <p class="due">{decision.blocking ? 'This needs an answer before time moves on.' : `${decision.dueText}. If you leave it, you will do what comes naturally.`}</p>
    </div>
  )
}

function Entry({ item, decision, actions, busy }: { item: FeedItem; decision: DecisionView | undefined; actions: Actions; busy: boolean }) {
  if (decision) {
    return (
      <li class="entry">
        <time>{item.dateText}</time>
        <Decision decision={decision} actions={actions} busy={busy} />
      </li>
    )
  }
  const kind = item.kind === 'year_summary' ? 'summary' : item.kind === 'obituary' ? 'obituary' : item.kind === 'death' ? 'death' : ''
  return (
    <li class={`entry ${kind}`}>
      <time>{item.dateText}</time>
      <div class="text">
        <p>{item.text}</p>
        {item.whyId && <Why outcomeId={item.whyId} actions={actions} />}
      </div>
    </li>
  )
}

function Feed({ view, actions, busy }: { view: PlayerView; actions: Actions; busy: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  const count = view.feed.length
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [count])
  const decisions = new Map(view.decisions.map((d) => [d.id, d]))
  return (
    <section class="feed" aria-label="Story" role="log" aria-live="polite">
      <ol>
        {view.feed.map((item) => (
          <Entry key={item.id} item={item} decision={item.decisionId ? decisions.get(item.decisionId) : undefined} actions={actions} busy={busy} />
        ))}
      </ol>
      <div ref={end} />
    </section>
  )
}

export function Game({ view, actions, busy }: { view: PlayerView; actions: Actions; busy: boolean }) {
  const [tab, setTab] = useState<TabId>('story')
  const search = useRef<HTMLInputElement>(null)
  const wantSearch = useRef(false)
  const alive = view.phase === 'alive'

  // "/" opens the life log and puts the cursor in its search box, which exists only once the
  // log panel has rendered.
  useEffect(() => {
    if (tab === 'log' && wantSearch.current) search.current?.focus()
    wantSearch.current = false
  }, [tab])

  const advance = (until: 'month' | 'season' | 'birthday'): void => {
    if (view.advance.allowed && !busy) void actions.send({ type: 'command', command: { type: 'advance', until } })
  }
  const decide = (index: number): void => {
    const decision = view.decisions[0]
    const option = decision?.options[index]
    if (decision && option && !busy) void actions.send({ type: 'command', command: { type: 'decide', decisionId: decision.id, optionId: option.id } })
  }

  // The key listener is attached once and reads the newest handlers through this ref, which is
  // updated during render. Re-attaching in an effect would leave a window after each update in
  // which the listener still held the previous render's "busy" flag and dropped a fast key press.
  const latest = useRef({ advance, decide })
  latest.current = { advance, decide }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (isTyping(event.target)) {
        if (event.key === 'Escape') (event.target as HTMLElement).blur()
        return
      }
      const onButton = (event.target as HTMLElement | null)?.tagName === 'BUTTON'
      const key = event.key
      if ((key === 'Enter' || key === ' ') && !onButton) {
        event.preventDefault()
        latest.current.advance('birthday')
      } else if (key === 'm') latest.current.advance('month')
      else if (key === 's') latest.current.advance('season')
      else if (key >= '1' && key <= '9') latest.current.decide(Number(key) - 1)
      else if (key === '/') {
        event.preventDefault()
        wantSearch.current = true
        setTab('log')
        search.current?.focus()
      } else if (key === '?') {
        const buttons = document.querySelectorAll<HTMLButtonElement>('.feed [data-why]')
        buttons[buttons.length - 1]?.click()
      } else {
        const match = TABS.find((t) => t.key === key)
        if (match) setTab(match.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div class="game" data-tab={tab}>
      <header class="status">
        <div class="who">
          <strong>{view.person.name}</strong>
          <span>{view.death ? `died at ${view.death.age}` : view.person.ageText}</span>
        </div>
        <dl>
          <div>
            <dt>Date</dt>
            <dd>
              {view.date.month} {view.date.year}
            </dd>
          </div>
          <div>
            <dt>Place</dt>
            <dd>{view.place}</dd>
          </div>
          {alive && (
            <div>
              <dt>Health</dt>
              <dd>{view.status.health}</dd>
            </div>
          )}
          {alive && (
            <div>
              <dt>Stage</dt>
              <dd>{view.person.stageLabel}</dd>
            </div>
          )}
        </dl>
      </header>

      <nav class="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)} title={`Shortcut: ${t.key}`}>
            {t.label}
          </button>
        ))}
      </nav>

      <div class="columns">
        <Feed view={view} actions={actions} busy={busy} />
        <aside class="panel" aria-label={TABS.find((t) => t.id === tab)?.label ?? 'Section'}>
          {(tab === 'school' || tab === 'story') && <SchoolPanel view={view} actions={actions} busy={busy} compact={tab === 'story'} />}
          {(tab === 'family' || tab === 'story') && <FamilyPanel view={view} compact={tab === 'story'} />}
          {(tab === 'routine' || tab === 'story') && <RoutinePanel view={view} actions={actions} busy={busy} />}
          {(tab === 'health' || tab === 'story') && <HealthPanel view={view} />}
          {tab === 'log' && <LogPanel view={view} actions={actions} searchRef={search} />}
          {tab === 'saves' && <SavesPanel view={view} actions={actions} />}
        </aside>
      </div>

      <footer class="actions">
        {alive ? (
          <>
            <button type="button" class="primary" disabled={!view.advance.allowed || busy} onClick={() => advance('birthday')}>
              Next birthday <kbd>Enter</kbd>
            </button>
            <button type="button" disabled={!view.advance.allowed || busy} onClick={() => advance('season')}>
              A season <kbd>S</kbd>
            </button>
            <button type="button" disabled={!view.advance.allowed || busy} onClick={() => advance('month')}>
              A month <kbd>M</kbd>
            </button>
            {view.advance.blockedReason && <span class="blocked">{view.advance.blockedReason}</span>}
          </>
        ) : (
          <button type="button" class="primary" onClick={() => void actions.send({ type: 'abandon' })}>
            Begin another life
          </button>
        )}
        <span class="hint">
          <kbd>1</kbd>–<kbd>9</kbd> choose · <kbd>?</kbd> why · <kbd>/</kbd> search
        </span>
      </footer>
    </div>
  )
}
