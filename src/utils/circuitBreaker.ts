/**
 * In-memory circuit breaker for Redis (or other external calls).
 * Avoids cascading latency when Redis is slow/down: after N failures, circuit opens
 * and calls are skipped (fallback) until a cooldown passes, then one probe is allowed (half-open).
 */

const DEFAULT_FAILURE_THRESHOLD = 5
const DEFAULT_OPEN_MS = 10_000
const DEFAULT_HALF_OPEN_TIMEOUT_MS = 2_000

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerOptions {
  failureThreshold?: number
  openDurationMs?: number
  halfOpenTimeoutMs?: number
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failures = 0
  private lastFailureAt = 0
  private halfOpenProbeAt = 0
  private readonly failureThreshold: number
  private readonly openDurationMs: number
  private readonly halfOpenTimeoutMs: number

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    this.openDurationMs = options.openDurationMs ?? DEFAULT_OPEN_MS
    this.halfOpenTimeoutMs = options.halfOpenTimeoutMs ?? DEFAULT_HALF_OPEN_TIMEOUT_MS
  }

  getState(): CircuitState {
    const now = Date.now()
    if (this.state === 'open') {
      if (now - this.lastFailureAt >= this.openDurationMs) {
        this.state = 'half-open'
        this.halfOpenProbeAt = now
      }
    }
    return this.state
  }

  /** Call before executing the protected operation. Returns true if the call should be skipped (circuit open). */
  shouldSkip(): boolean {
    const s = this.getState()
    if (s === 'closed') return false
    if (s === 'open') return true
    if (s === 'half-open') {
      if (Date.now() - this.halfOpenProbeAt >= this.halfOpenTimeoutMs) return false
      return true
    }
    return false
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed'
      this.failures = 0
    } else if (this.state === 'closed') {
      this.failures = 0
    }
  }

  recordFailure(): void {
    const now = Date.now()
    this.lastFailureAt = now
    if (this.state === 'half-open') {
      this.state = 'open'
    } else if (this.state === 'closed') {
      this.failures += 1
      if (this.failures >= this.failureThreshold) {
        this.state = 'open'
      }
    }
  }
}

/** Shared Redis circuit breaker; use for cache get and similar read paths. */
export const redisCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  openDurationMs: 10_000,
  halfOpenTimeoutMs: 2_000,
})

/**
 * Per-dependency breakers for Phase 4 coverage. Thresholds are tuned per
 * dependency rather than reusing one global setting — see
 * docs/REMEDIATION_PLAN.md Phase 4 and CHANGELOG-remediation.md for the
 * rationale behind each value.
 */

/** Primary DB connection/availability failures only (see isDbInfraError). High
 * threshold — a false-open here is catastrophic since there's no fallback for
 * a DB read/write — with a fast recovery once the half-open probe succeeds. */
export const dbCircuitBreaker = new CircuitBreaker({
  failureThreshold: 15,
  openDurationMs: 5_000,
  halfOpenTimeoutMs: 1_000,
})

/** Separate instance for the read replica so a replica-only outage can't
 * fail-fast primary-served requests (and vice versa). */
export const dbReadCircuitBreaker = new CircuitBreaker({
  failureThreshold: 15,
  openDurationMs: 5_000,
  halfOpenTimeoutMs: 1_000,
})

export const s3CircuitBreaker = new CircuitBreaker({
  failureThreshold: 6,
  openDurationMs: 15_000,
  halfOpenTimeoutMs: 3_000,
})

export const rekognitionCircuitBreaker = new CircuitBreaker({
  failureThreshold: 6,
  openDurationMs: 15_000,
  halfOpenTimeoutMs: 3_000,
})

export const livekitCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  openDurationMs: 15_000,
  halfOpenTimeoutMs: 3_000,
})

/** Lower threshold, longer cooldown — payment gateway outages tend to run
 * longer and this path is low-frequency enough that a longer cooldown is
 * cheap. Sits above epayClient's own axios-level 5xx retry+backoff. */
export const epayCircuitBreaker = new CircuitBreaker({
  failureThreshold: 4,
  openDurationMs: 20_000,
  halfOpenTimeoutMs: 5_000,
})

export const msg91CircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  openDurationMs: 15_000,
  halfOpenTimeoutMs: 3_000,
})

export const sesCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  openDurationMs: 15_000,
  halfOpenTimeoutMs: 3_000,
})

/**
 * Classifies a thrown Prisma/DB error as an infrastructure failure (connection
 * refused/reset, pool timeout, engine crash) vs. an expected business-logic
 * outcome (unique violation, not-found, serialization conflict) that fires
 * routinely under healthy load and must not trip the breaker.
 */
const DB_BUSINESS_ERROR_CODES = new Set([
  'P2002', // unique constraint violation
  'P2025', // record not found
  'P2034', // transaction/serialization conflict (already retried via withSerializationRetry)
  'P2003', // foreign key constraint violation
])

const DB_INFRA_ERROR_CODES = new Set([
  'P1001', // can't reach database server
  'P1002', // database server timed out
  'P1008', // operation timed out
  'P1009', // database already exists (provisioning, not a live-traffic case, but connection-shaped)
  'P1010', // access denied
  'P1011', // TLS connection error
  'P1017', // server closed the connection
  'P2024', // timed out fetching a connection from the pool
])

export function isDbInfraError(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code)
      : undefined
  if (code && DB_BUSINESS_ERROR_CODES.has(code)) return false
  if (code && DB_INFRA_ERROR_CODES.has(code)) return true
  // Unrecognized Prisma business codes (P2xxx not listed above, validation
  // errors, etc.) are application-shaped, not infra-shaped — don't trip the
  // breaker on them. Anything with no Prisma error code at all (raw
  // ECONNREFUSED/ECONNRESET, engine crash) is treated as infra.
  if (code && code.startsWith('P2')) return false
  return true
}
