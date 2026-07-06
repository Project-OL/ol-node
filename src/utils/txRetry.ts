import { Prisma } from '@prisma/client'

/**
 * True for transaction aborts that are safe to retry: Prisma P2034
 * (serialization/deadlock on model queries) and P2010 raw-query failures with
 * Postgres SQLSTATE 40001 (serialization_failure) or 40P01 (deadlock_detected)
 * — the latter is what SELECT ... FOR UPDATE surfaces under Serializable when
 * the lock holder commits first.
 */
export function isSerializationAbort(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (err.code === 'P2034') return true
  if (err.code === 'P2010') {
    const pgCode = (err.meta as { code?: string } | undefined)?.code
    return pgCode === '40001' || pgCode === '40P01'
  }
  return false
}

/**
 * Run a transaction-producing function, retrying serialization/deadlock aborts
 * with small jittered backoff. The function must be safe to re-run from scratch
 * (all effects inside the transaction, deterministic idempotency keys).
 */
export async function withSerializationRetry<T>(
  run: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      if (attempt < maxAttempts && isSerializationAbort(err)) {
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)))
        continue
      }
      throw err
    }
  }
}

/** True when a write hit a unique constraint (e.g. an idempotency key already settled). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}
