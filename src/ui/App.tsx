import { useCallback, useEffect, useState } from 'preact/hooks'
import type { GameClient } from '../app/client'
import type { Explanation, PlayerView, Request } from '../app/protocol'
import { Game } from './Game'
import { Start } from './Start'

export interface Actions {
  /** Sends a request; resolves to false if the game refused it (the reason is shown). */
  send(request: Request): Promise<boolean>
  explain(outcomeId: string): Promise<Explanation | null>
  exportSave(): Promise<string | null>
  clearError(): void
}

export function App({ client }: { client: GameClient }) {
  const [view, setView] = useState<PlayerView | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const send = useCallback(
    async (request: Request): Promise<boolean> => {
      setBusy(true)
      const reply = await client.send(request)
      setBusy(false)
      if (!reply.ok) {
        setError(reply.error)
        return false
      }
      setError('')
      setView(reply.view)
      return true
    },
    [client],
  )

  useEffect(() => {
    void send({ type: 'init' }).then(() => setReady(true))
  }, [send])

  const actions: Actions = {
    send,
    async explain(outcomeId) {
      const reply = await client.send({ type: 'explain', outcomeId })
      return reply.ok ? (reply.explanation ?? null) : null
    },
    async exportSave() {
      const reply = await client.send({ type: 'export' })
      if (!reply.ok) {
        setError(reply.error)
        return null
      }
      return reply.saveText ?? null
    },
    clearError: () => setError(''),
  }

  if (!ready) return <p class="loading">Loading…</p>
  return (
    <>
      {error && (
        <div class="error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      {view ? <Game view={view} actions={actions} busy={busy} /> : <Start actions={actions} busy={busy} />}
    </>
  )
}
