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
