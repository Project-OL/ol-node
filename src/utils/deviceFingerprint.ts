import crypto from 'crypto'

/** SHA-256 hex of deviceId + userAgent + IP (server-side binding signal; not proof of possession). */
export function computeDeviceBindingHash(
  deviceId: string,
  userAgent: string | null | undefined,
  ipAddress: string,
): string {
  const ua = userAgent ?? ''
  return crypto.createHash('sha256').update(`${deviceId}|${ua}|${ipAddress}`).digest('hex')
}

export function hashIp(ipAddress: string): string {
  return crypto.createHash('sha256').update(ipAddress).digest('hex')
}

export function hashUserAgent(userAgent: string | null | undefined): string {
  return crypto.createHash('sha256').update(userAgent ?? '').digest('hex')
}
