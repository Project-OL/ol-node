/**
 * Free-text country helpers for `users.country` / `system_admins.country`.
 * Canonical storage is trimmed Title Case (e.g. India); comparisons are case-insensitive.
 */

/** Trim, collapse whitespace, Title Case each word (`INDIA` → `India`). */
export function normalizeCountry(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** Empty / whitespace → null; otherwise Title Case. */
export function normalizeCountryOptional(value: string | null | undefined): string | null {
  if (value == null) return null
  const normalized = normalizeCountry(value)
  return normalized.length > 0 ? normalized : null
}

/** Lowercase Title-Case segment for Redis keys so casing does not split caches. */
export function countryCacheKeySegment(value: string): string {
  return normalizeCountry(value).toLowerCase()
}

/** True when both sides have the same non-empty country (case-insensitive). */
export function countriesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a?.trim().toLowerCase()
  const right = b?.trim().toLowerCase()
  return !!left && !!right && left === right
}

/** Prisma string filter: equality ignoring case (value normalized to Title Case). */
export function countryEqualsFilter(value: string): {
  equals: string
  mode: 'insensitive'
} {
  return { equals: normalizeCountry(value), mode: 'insensitive' }
}
