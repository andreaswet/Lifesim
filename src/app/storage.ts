/**
 * The autosave slot, in IndexedDB (design §4.6). Storage can be unavailable (private windows,
 * blocked site data), so every operation fails soft: the game still plays, it just does not persist.
 */

const DB = 'lifesim'
const STORE = 'saves'
const KEY = 'autosave'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  try {
    const db = await open()
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } catch {
    return null
  }
}

export async function loadAutosave(): Promise<string | null> {
  const value = await run('readonly', (store) => store.get(KEY) as IDBRequest<unknown>)
  return typeof value === 'string' ? value : null
}

export async function storeAutosave(text: string): Promise<void> {
  await run('readwrite', (store) => store.put(text, KEY))
}

export async function clearAutosave(): Promise<void> {
  await run('readwrite', (store) => store.delete(KEY))
}
