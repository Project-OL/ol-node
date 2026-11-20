import crypto from 'crypto'

/**
 * Epay request/callback signature (https://opendocs.epay.com/gateway/cn/before/api_sign.html):
 *  1. drop empty values ('' / null / undefined, and objects that end up empty)
 *  2. sort keys in ASCII order (case-sensitive)
 *  3. join as `k=v&k2=v2`; a nested object becomes `k={a=1&b=2}` (recursively sorted)
 *  4. append `&key=<API key>`
 *  5. SHA-256, uppercase hex
 * Nested pairs are joined with `&` (the doc's worked example and all three code samples agree;
 * its prose says `,` but that disagrees with its own example).
 * The top-level `sign` field is never part of the signed string.
 */

export type EpaySignValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | { [key: string]: EpaySignValue }

export type EpaySignParams = { [key: string]: EpaySignValue }

function isPlainObject(v: unknown): v is EpaySignParams {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function serialize(obj: EpaySignParams, topLevel: boolean): string {
  const parts: string[] = []
  // Default sort compares UTF-16 code units = ASCII order for ASCII keys.
  for (const key of Object.keys(obj).sort()) {
    if (topLevel && key === 'sign') continue
    const value = obj[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      throw new Error(`Epay sign: array values are not supported (field "${key}")`)
    }
    if (isPlainObject(value)) {
      const inner = serialize(value, false)
      if (inner === '') continue
      parts.push(`${key}={${inner}}`)
      continue
    }
    parts.push(`${key}=${String(value)}`)
  }
  return parts.join('&')
}

/** Pre-hash string, exported for tests and for debugging sign mismatches in the sandbox. */
export function buildEpaySignString(params: EpaySignParams, key: string): string {
  const body = serialize(params, true)
  return body === '' ? `key=${key}` : `${body}&key=${key}`
}

export function epaySign(params: EpaySignParams, key: string): string {
  return crypto
    .createHash('sha256')
    .update(buildEpaySignString(params, key), 'utf8')
    .digest('hex')
    .toUpperCase()
}

/** Constant-time check of `params.sign` (or an explicit signature) against our own computation. */
export function verifyEpaySign(params: EpaySignParams, key: string, signature?: string): boolean {
  const received = String(signature ?? params.sign ?? '')
    .trim()
    .toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(received)) return false
  const expected = epaySign(params, key)
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'))
}
