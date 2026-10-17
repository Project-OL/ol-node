import { createHmac, timingSafeEqual } from 'crypto'

/**
 * BE-20 internal API request signing (mirrored in Live-server `src/services/ledgerClient.js`).
 *
 *   X-OL-Timestamp: <unix ms>
 *   X-OL-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${METHOD}.${path}.${rawBody}`)>
 *
 * `path` is the request path without the query string. A timestamp more than
 * MAX_SKEW_MS away from now is rejected, so a captured request can't be replayed later
 * (and inside the window every operation is idempotent on its requestId anyway).
 */
export const SIGNATURE_HEADER = 'x-ol-signature'
export const TIMESTAMP_HEADER = 'x-ol-timestamp'
export const MAX_SKEW_MS = 30_000

export function signInternalRequest(
  secret: string,
  params: { timestamp: string; method: string; path: string; body: string },
): string {
  const mac = createHmac('sha256', secret)
    .update(`${params.timestamp}.${params.method.toUpperCase()}.${params.path}.${params.body}`)
    .digest('hex')
  return `v1=${mac}`
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

export function verifyInternalRequest(
  secret: string,
  params: {
    signature: string | undefined
    timestamp: string | undefined
    method: string
    path: string
    body: string
    nowMs?: number
  },
): VerifyResult {
  if (!params.signature || !params.timestamp) return { ok: false, reason: 'missing_signature' }
  const ts = Number(params.timestamp)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' }
  if (Math.abs((params.nowMs ?? Date.now()) - ts) > MAX_SKEW_MS) {
    return { ok: false, reason: 'stale_timestamp' }
  }
  const expected = Buffer.from(
    signInternalRequest(secret, {
      timestamp: params.timestamp,
      method: params.method,
      path: params.path,
      body: params.body,
    }),
  )
  const actual = Buffer.from(params.signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' }
  }
  return { ok: true }
}
