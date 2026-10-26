import { Prisma, PrismaClient } from '@prisma/client'
import { env } from './env'
import { labRequestContext } from '../utils/labRequestContext'
import { AppError } from '../middlewares/errorHandler'
import {
  dbCircuitBreaker,
  dbReadCircuitBreaker,
  isDbInfraError,
  type CircuitBreaker,
} from '../utils/circuitBreaker'
import {
  LUCKY_NESTED_PRISMA_GUARD_MODE,
  reportNestedPrismaUse,
} from '../services/luckyWater/luckyMoneyTxContext'

declare global {
  // eslint-disable-next-line no-var -- required for Node global augmentation in dev hot-reload
  var __prisma: PrismaClient | undefined
  // eslint-disable-next-line no-var -- required for Node global augmentation in dev hot-reload
  var __prismaRead: PrismaClient | undefined
}

const baseLog: Prisma.LogLevel[] = ['error', 'warn']
const devLog: Prisma.LogLevel[] =
  env.NODE_ENV === 'development' && !env.LAB_REQUEST_METRICS ? ['query', 'error', 'warn'] : baseLog

const prismaLog: Prisma.LogDefinition[] = env.LAB_REQUEST_METRICS
  ? [
      { level: 'error', emit: 'stdout' },
      { level: 'warn', emit: 'stdout' },
    ]
  : devLog.map((level) => ({ level, emit: 'stdout' as const }))

const prismaOptions: Prisma.PrismaClientOptions = {
  log: prismaLog,
  errorFormat: 'minimal',
}

/** $-ops safe to call on the global client while a lucky money ALS span is active. */
const GLOBAL_PRISMA_OK_WHILE_MONEY_TX = new Set([
  '$transaction',
  '$connect',
  '$disconnect',
  '$on',
  '$use',
  '$extends',
  '$parent',
])

/**
 * G2: Proxy the *global* prisma export so model / $queryRaw access under ALS is logged or thrown.
 * Mode `off`: identity — returns the same client (no Proxy).
 * Interactive `tx` from `$transaction` is a different object and is not proxied — so tx.* is fine.
 * Do NOT put this assert in `$extends` `$allOperations`: Prisma routes tx queries through that hook too.
 */
export function withLuckyNestedPrismaGuard(client: PrismaClient): PrismaClient {
  if (LUCKY_NESTED_PRISMA_GUARD_MODE === 'off') return client

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'then' || typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }
      const name = String(prop)
      if (name.startsWith('$')) {
        if (!GLOBAL_PRISMA_OK_WHILE_MONEY_TX.has(name)) {
          reportNestedPrismaUse({ model: name, operation: '' })
        }
        const value = Reflect.get(target, prop, receiver)
        if (typeof value === 'function') return (value as (...a: unknown[]) => unknown).bind(target)
        return value
      }

      // Model delegate: wrap so the *operation* (findMany, create, …) is attributed.
      const delegate = Reflect.get(target, prop, receiver)
      if (delegate == null || typeof delegate !== 'object') {
        return delegate
      }
      return new Proxy(delegate as object, {
        get(modelTarget, opProp, modelReceiver) {
          if (typeof opProp === 'symbol') {
            return Reflect.get(modelTarget, opProp, modelReceiver)
          }
          const op = String(opProp)
          reportNestedPrismaUse({ model: name, operation: op })
          const opValue = Reflect.get(modelTarget, opProp, modelReceiver)
          if (typeof opValue === 'function') {
            return (opValue as (...a: unknown[]) => unknown).bind(modelTarget)
          }
          return opValue
        },
      })
    },
  }) as PrismaClient
}

function withLabQueryCounter(client: PrismaClient): PrismaClient {
  if (!env.LAB_REQUEST_METRICS) return client
  return client.$extends({
    query: {
      $allOperations({ query, args }) {
        labRequestContext.incrementDb()
        return query(args)
      },
    },
  }) as unknown as PrismaClient
}

/**
 * Fail-fast wrapper: when the breaker is open, skip the query entirely and
 * throw immediately instead of letting the request hang until Prisma's own
 * connection/pool timeout. Only connection/availability-shaped errors (see
 * isDbInfraError) count as breaker failures — expected business-logic
 * outcomes (unique violations, serialization conflicts, etc.) fire routinely
 * under healthy load and must not trip it.
 */
export function withCircuitBreaker(client: PrismaClient, breaker: CircuitBreaker): PrismaClient {
  return client.$extends({
    query: {
      // Declared async so a shouldSkip() throw always yields a rejected
      // promise, regardless of how the caller's dispatch pipeline invokes
      // this hook (a bare synchronous throw would otherwise escape as an
      // uncaught exception rather than a query rejection in some contexts).
      async $allOperations({ query, args }) {
        if (breaker.shouldSkip()) {
          throw new AppError(503, 'Database temporarily unavailable', 'DB_CIRCUIT_OPEN')
        }
        try {
          const result = await query(args)
          breaker.recordSuccess()
          return result
        } catch (err) {
          if (isDbInfraError(err)) breaker.recordFailure()
          throw err
        }
      },
    },
  }) as unknown as PrismaClient
}

/** Honor DATABASE_POOL_MAX when the URL does not already set connection_limit. */
export function withConnectionLimit(url: string): string {
  if (/[?&]connection_limit=/i.test(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}connection_limit=${env.DATABASE_POOL_MAX}`
}

function createClient(url: string, breaker: CircuitBreaker): PrismaClient {
  const base = new PrismaClient({
    ...prismaOptions,
    datasources: { db: { url: withConnectionLimit(url) } },
  })
  // Circuit/lab wrappers always apply; nested-prisma Proxy only when mode ≠ off.
  return withLuckyNestedPrismaGuard(withCircuitBreaker(withLabQueryCounter(base), breaker))
}

export const prisma = global.__prisma ?? createClient(env.DATABASE_URL, dbCircuitBreaker)
export const prismaRead: PrismaClient =
  global.__prismaRead ??
  (env.DATABASE_READ_URL ? createClient(env.DATABASE_READ_URL, dbReadCircuitBreaker) : prisma)

if (env.NODE_ENV !== 'production') {
  global.__prisma = prisma
  global.__prismaRead = prismaRead
}

/** Warm pooler connections on process start (avoids first-request P1017 on Neon). */
export async function connectDatabases(): Promise<void> {
  await prisma.$connect()
  if (prismaRead !== prisma) {
    await prismaRead.$connect()
  }
}
