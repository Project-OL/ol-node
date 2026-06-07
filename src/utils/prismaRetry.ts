import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

const RETRYABLE_CODES = new Set(['P1017', 'P1001', 'P1008', 'P2024'])

/**
 * Retry transient Neon/pooler connection drops (P1017 "Server has closed the connection").
 */
export async function withDbRetry<T>(
  client: PrismaClient,
  fn: () => Promise<T>,
  retries = 2,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const code = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null
      if (code && RETRYABLE_CODES.has(code) && attempt < retries) {
        await client.$disconnect().catch(() => undefined)
        await client.$connect()
        continue
      }
      throw err
    }
  }
  throw lastErr
}
