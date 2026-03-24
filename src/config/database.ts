import { PrismaClient } from '@prisma/client'
import { env } from './env'

declare global {
  var __prisma: PrismaClient | undefined
  var __prismaRead: PrismaClient | undefined
}

const prismaOptions: { log: ('query' | 'error' | 'warn')[]; errorFormat: 'minimal' } = {
  log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  errorFormat: 'minimal',
}

export const prisma =
  global.__prisma ??
  new PrismaClient(prismaOptions)

/** Read replica client when DATABASE_READ_URL is set; use for read-only queries to scale reads. */
export const prismaRead: PrismaClient =
  global.__prismaRead ??
  (env.DATABASE_READ_URL
    ? new PrismaClient({ ...prismaOptions, datasources: { db: { url: env.DATABASE_READ_URL } } })
    : prisma)

if (env.NODE_ENV !== 'production') {
  global.__prisma = prisma
  global.__prismaRead = prismaRead
}