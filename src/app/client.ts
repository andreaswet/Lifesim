/** The interface's side of the worker: send a request, await the reply. */

import type { Envelope, Reply, Request } from './protocol'

export interface GameClient {
  send(request: Request): Promise<Reply>
}

export function createClient(): GameClient {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const waiting = new Map<number, (reply: Reply) => void>()
  let next = 1

  worker.onmessage = (event: MessageEvent<Envelope<Reply>>) => {
    const { id, ...reply } = event.data
    waiting.get(id)?.(reply as Reply)
    waiting.delete(id)
  }
  worker.onerror = (event) => {
    for (const resolve of waiting.values()) resolve({ ok: false, error: `The game engine failed to start: ${event.message}` })
    waiting.clear()
  }

  return {
    send(request) {
      return new Promise((resolve) => {
        const id = next++
        waiting.set(id, resolve)
        worker.postMessage({ id, ...request })
      })
    },
  }
}
