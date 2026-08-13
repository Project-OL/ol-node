import { normalizePhone } from '../lib/utils/phone.util'
import type { AdminUserSearchType } from '../models/admin-user-search.schemas'

export const ADMIN_USER_SEARCH_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A person's name: letters (any script), spaces, apostrophes, hyphens, periods. */
const NAME_LIKE_RE = /^[\p{L}][\p{L}\s'.-]*$/u

export type AdminUserSearchResolvedType = Exclude<AdminUserSearchType, 'auto'>

/**
 * How `type=auto` maps a query. Alphabetic tokens (including a first name alone)
 * resolve to `name`, not `deviceId`.
 */
export function resolveAdminUserSearchAutoType(query: string): AdminUserSearchResolvedType {
  const q = query.trim()
  if (ADMIN_USER_SEARCH_UUID_RE.test(q)) return 'userId'
  if (/^\d+$/.test(q)) return 'publicId'
  if (EMAIL_RE.test(q)) return 'email'
  if (normalizePhone(q)) return 'phone'
  if (NAME_LIKE_RE.test(q)) return 'name'
  if (q.length >= 8 && /^[a-zA-Z0-9_-]+$/.test(q)) return 'deviceId'
  return 'name'
}
