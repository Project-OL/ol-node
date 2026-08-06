import { isIP } from 'net'

/**
 * Normalize a client IP for storage and exact-match comparisons.
 * - trims whitespace
 * - maps `:ffff:x.x.x.x` → `x.x.x.x`
 * - lowercases IPv6
 * Returns null when the value is not a valid IPv4/IPv6 address.
 */
export function normalizeIp(ip: string | undefined | null): string | null {
  if (ip == null) return null
  const trimmed = ip.trim()
  if (!trimmed) return null

  const v4mapped = trimmed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  const candidate = v4mapped ? v4mapped[1] : trimmed
  if (isIP(candidate) === 0) return null
  return candidate.toLowerCase()
}

export function isValidExactIp(ip: string): boolean {
  return normalizeIp(ip) !== null
}
