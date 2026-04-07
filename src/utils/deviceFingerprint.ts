import crypto from 'crypto'
import { env } from '../config/env'

/**
 * HMAC-SHA256 of (deviceId | userAgent | IP) keyed with DEVICE_FINGERPRINT_SECRET.
 * Using HMAC instead of plain SHA-256 prevents pre-computation attacks: an attacker
 * who knows the three input values cannot forge the fingerprint without the server secret.
 * Falls back to a plain SHA-256 in non-production environments where the secret is optional.
 */
export function computeDeviceBindingHash(
  deviceId: string,
  userAgent: string | null | undefined,
  ipAddress: string,
): string {
  const ua = userAgent ?? ''
  const payload = `${deviceId}|${ua}|${ipAddress}`
  const secret = env.DEVICE_FINGERPRINT_SECRET
  if (secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex')
  }
  // Non-production fallback (secret not set): plain SHA-256
  return crypto.createHash('sha256').update(payload).digest('hex')
}

export function hashIp(ipAddress: string): string {
  return crypto.createHash('sha256').update(ipAddress).digest('hex')
}

export function hashUserAgent(userAgent: string | null | undefined): string {
  return crypto.createHash('sha256').update(userAgent ?? '').digest('hex')
}
