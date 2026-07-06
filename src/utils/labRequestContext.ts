import { AsyncLocalStorage } from 'node:async_hooks'

export type LabRequestStore = {
  dbQueries: number
  redisOps: number
}

const storage = new AsyncLocalStorage<LabRequestStore>()

function getStore(): LabRequestStore | undefined {
  return storage.getStore()
}

function getOrCreateStore(): LabRequestStore {
  const existing = getStore()
  if (existing) return existing
  const fresh: LabRequestStore = { dbQueries: 0, redisOps: 0 }
  storage.enterWith(fresh)
  return fresh
}

export const labRequestContext = {
  startRequest(): void {
    storage.enterWith({ dbQueries: 0, redisOps: 0 })
  },

  run<T>(fn: () => T): T {
    return storage.run({ dbQueries: 0, redisOps: 0 }, fn)
  },

  incrementDb(count = 1): void {
    getOrCreateStore().dbQueries += count
  },

  incrementRedis(count = 1): void {
    getOrCreateStore().redisOps += count
  },

  snapshot(): { dbQueries: number; redisOps: number } {
    const store = getStore()
    return { dbQueries: store?.dbQueries ?? 0, redisOps: store?.redisOps ?? 0 }
  },
}
