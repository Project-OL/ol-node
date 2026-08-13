/**
 * In-process singleflight: concurrent callers with the same key share one promise.
 * Prevents cache-miss stampedes on one Node process (wallet balance, /me, etc.).
 */
const inflight = new Map<string, Promise<unknown>>()

export function singleflight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const p = run().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key)
  })
  inflight.set(key, p)
  return p
}
