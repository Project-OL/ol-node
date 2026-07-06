import { getRedisForRead, redisClient } from '../config/redis'
import { env } from '../config/env'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'cacheRedis' })
const timeoutMs = env.REDIS_COMMAND_TIMEOUT_MS

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Redis command timeout: ${label}`))
    }, timeoutMs)
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export const cacheRedisService = {
  async get<T>(key: string): Promise<T | null> {
    const started = Date.now()
    try {
      // Cache-aside reads go to the read replica when REDIS_READ_URL is set; set/del stay on primary.
      const raw = await withTimeout(getRedisForRead().get(key), `GET ${key}`)
      if (raw == null) {
        log.debug({ key, latencyMs: Date.now() - started, result: 'MISS' }, 'cache get')
        return null
      }
      log.debug({ key, latencyMs: Date.now() - started, result: 'HIT' }, 'cache get')
      return JSON.parse(raw) as T
    } catch (err) {
      log.warn({ err, key, latencyMs: Date.now() - started }, 'cache get failed; treating as miss')
      return null
    }
  },

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const started = Date.now()
    try {
      const payload = JSON.stringify(value)
      await withTimeout(redisClient.set(key, payload, 'EX', ttlSeconds), `SET ${key}`)
      log.debug({ key, ttlSeconds, latencyMs: Date.now() - started }, 'cache set')
    } catch (err) {
      log.warn({ err, key, latencyMs: Date.now() - started }, 'cache set failed')
    }
  },

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return
    const started = Date.now()
    try {
      await withTimeout(redisClient.del(...keys), `DEL ${keys.join(',')}`)
      log.debug({ keys, latencyMs: Date.now() - started }, 'cache del')
    } catch (err) {
      log.warn({ err, keys, latencyMs: Date.now() - started }, 'cache del failed')
    }
  },

  /**
   * Delete every key whose name starts with `prefix` (Redis SCAN + DEL batches).
   * Used when list payloads are cached under `${prefix}:filter:…` but mutations only knew the base prefix.
   */
  async delByKeyPrefix(prefix: string): Promise<void> {
    if (!prefix) return
    const pattern = `${prefix}*`
    const started = Date.now()
    try {
      let cursor = '0'
      let totalDeleted = 0
      do {
        const [next, keys] = await withTimeout(
          redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 200),
          `SCAN ${pattern}`,
        )
        cursor = next
        if (keys.length > 0) {
          await withTimeout(redisClient.del(...keys), `DEL ${keys.length} keys`)
          totalDeleted += keys.length
        }
      } while (cursor !== '0')
      log.debug(
        { prefix, pattern, totalDeleted, latencyMs: Date.now() - started },
        'cache delByKeyPrefix',
      )
    } catch (err) {
      log.warn(
        { err, prefix, pattern, latencyMs: Date.now() - started },
        'cache delByKeyPrefix failed',
      )
    }
  },

  async exists(key: string): Promise<boolean> {
    try {
      const n = await withTimeout(redisClient.exists(key), `EXISTS ${key}`)
      return n === 1
    } catch {
      return false
    }
  },

  async ttl(key: string): Promise<number> {
    try {
      return await withTimeout(redisClient.ttl(key), `TTL ${key}`)
    } catch {
      return -2
    }
  },
}
