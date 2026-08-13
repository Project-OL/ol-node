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

declare global {
  // eslint-disable-next-line no-var -- required for Node global augmentation in dev hot-reload
  var __prisma: PrismaClient | undefined
  // eslint-disable-next-line no-var -- required for Node global augmentation in dev hot-reload
  var __prismaRead: PrismaClient | undefined
}

const baseLog: Prisma.LogLevel[] = ['error', 'warn']
const devLog: Prisma.LogLevel[] =
  env.NODE_ENV === 'development' && !env.LAB_REQUEST_METRICS
    ? ['query', 'error', 'warn']
    : baseLog

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
  return withCircuitBreaker(withLabQueryCounter(base), breaker)
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
