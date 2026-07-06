import { Prisma, PrismaClient } from '@prisma/client'
import { env } from './env'
import { labRequestContext } from '../utils/labRequestContext'

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

function createClient(readUrl?: string): PrismaClient {
  const base =
    readUrl != null
      ? new PrismaClient({ ...prismaOptions, datasources: { db: { url: readUrl } } })
      : new PrismaClient(prismaOptions)
  return withLabQueryCounter(base)
}

export const prisma = global.__prisma ?? createClient()
export const prismaRead: PrismaClient =
  global.__prismaRead ??
  (env.DATABASE_READ_URL ? createClient(env.DATABASE_READ_URL) : prisma)

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
