import type { AuthProvider } from '../models/types'

/**
 * Canonical form of an email used as a login identifier: trimmed and lower-cased.
 *
 * `auth_identifiers (provider, identifier)` is a case-sensitive unique index, so without this
 * `Abcd@gmail.com` and `abcd@gmail.com` register as two accounts and OTPs/logins only match the
 * exact casing that was typed. Mailboxes are case-insensitive in practice (RFC 5321 allows a
 * case-sensitive local part, but no major provider honours it), so we treat the whole address
 * as case-insensitive. Every path that reads or writes an email identifier must go through this.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Looks like an email — used when the provider is not known (e.g. password-reset by identifier). */
export function looksLikeEmail(identifier: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(identifier.trim())
}

/**
 * Normalise an auth identifier for storage/lookup. Emails are lower-cased; everything else
 * (E.164 phone, OAuth provider ids, public ids) is only trimmed — those are case-significant or
 * already canonical.
 */
export function normalizeAuthIdentifier(
  provider: AuthProvider | 'publicId' | string,
  identifier: string,
): string {
  if (provider === 'email') return normalizeEmail(identifier)
  return identifier.trim()
}

/** Same, when the caller does not know the provider: lower-case only if it looks like an email. */
export function normalizeIdentifierGuess(identifier: string): string {
  return looksLikeEmail(identifier) ? normalizeEmail(identifier) : identifier.trim()
}
