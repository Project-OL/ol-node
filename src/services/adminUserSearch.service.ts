import { AppError } from '../middlewares/errorHandler'
import { normalizePhone } from '../lib/utils/phone.util'
import type { AdminUserSearchQuery, AdminUserSearchType } from '../models/admin-user-search.schemas'
import {
  adminUserSearchRepository,
  type AdminUserSearchRow,
} from '../repositories/adminUserSearch.repository'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type AdminUserSearchMatchType =
  | 'userId'
  | 'publicId'
  | 'email'
  | 'phone'
  | 'deviceId'
  | 'name'

export interface AdminUserSearchResultItem {
  userId: string
  name: string
  username: string
  publicId: string
  displayPublicId: string
  status: string
  isAgent: boolean
  adminTags: string[]
  avatarUrl: string | null
  email: string | null
  phone: string | null
  matchedBy: AdminUserSearchMatchType
}

function pickContact(
  identifiers: AdminUserSearchRow['authIdentifiers'],
  provider: 'email' | 'phone',
): string | null {
  const primary = identifiers.find((i) => i.provider === provider && i.isPrimary)
  const any = identifiers.find((i) => i.provider === provider)
  return primary?.identifier ?? any?.identifier ?? null
}

function mapRow(
  row: AdminUserSearchRow,
  matchedBy: AdminUserSearchMatchType,
): AdminUserSearchResultItem {
  return {
    userId: row.id,
    name: buildUserDisplayName(row),
    username: row.username,
    publicId: String(row.publicId),
    displayPublicId: resolveDisplayPublicId(row),
    status: row.status,
    isAgent: row.isAgent,
    adminTags: row.adminTags,
    avatarUrl: row.avatarUrl,
    email: pickContact(row.authIdentifiers, 'email'),
    phone: pickContact(row.authIdentifiers, 'phone'),
    matchedBy,
  }
}

function resolveAutoType(query: string): Exclude<AdminUserSearchType, 'auto'> {
  if (UUID_RE.test(query)) return 'userId'
  if (/^\d+$/.test(query)) return 'publicId'
  if (EMAIL_RE.test(query)) return 'email'
  if (normalizePhone(query)) return 'phone'
  if (query.length >= 8 && /^[a-zA-Z0-9_-]+$/.test(query)) return 'deviceId'
  return 'name'
}

export const adminUserSearchService = {
  async search(params: AdminUserSearchQuery): Promise<{
    users: AdminUserSearchResultItem[]
    matchedBy: AdminUserSearchMatchType | null
  }> {
    const query = params.q.trim()
    const effectiveType = params.type === 'auto' ? resolveAutoType(query) : params.type

    if (effectiveType === 'name' && query.length < 2) {
      throw new AppError(400, 'Name search requires at least 2 characters', 'INVALID_REQUEST')
    }

    if (effectiveType === 'userId') {
      if (!UUID_RE.test(query)) {
        throw new AppError(400, 'Invalid user id (UUID expected)', 'INVALID_REQUEST')
      }
      const row = await adminUserSearchRepository.findByUserId(query)
      if (row) {
        return { users: [mapRow(row, 'userId')], matchedBy: 'userId' }
      }
      if (params.type === 'auto') {
        return this.searchByDevice(query, params.limit)
      }
      return { users: [], matchedBy: null }
    }

    if (effectiveType === 'publicId') {
      let publicId: bigint
      try {
        publicId = BigInt(query)
      } catch {
        throw new AppError(400, 'Invalid public id', 'INVALID_PUBLIC_ID')
      }
      if (publicId <= 0n) {
        throw new AppError(400, 'Invalid public id', 'INVALID_PUBLIC_ID')
      }
      const row = await adminUserSearchRepository.findByPublicId(publicId)
      return {
        users: row ? [mapRow(row, 'publicId')] : [],
        matchedBy: row ? 'publicId' : null,
      }
    }

    if (effectiveType === 'email') {
      const row = await adminUserSearchRepository.findByEmail(query.toLowerCase())
      return {
        users: row ? [mapRow(row, 'email')] : [],
        matchedBy: row ? 'email' : null,
      }
    }

    if (effectiveType === 'phone') {
      const normalized = normalizePhone(query)
      if (!normalized) {
        throw new AppError(400, 'Invalid phone number', 'INVALID_PHONE')
      }
      const row = await adminUserSearchRepository.findByPhone(normalized)
      return {
        users: row ? [mapRow(row, 'phone')] : [],
        matchedBy: row ? 'phone' : null,
      }
    }

    if (effectiveType === 'deviceId') {
      return this.searchByDevice(query, params.limit)
    }

    const rows = await adminUserSearchRepository.searchByName(query, params.limit)
    return {
      users: rows.map((row) => mapRow(row, 'name')),
      matchedBy: rows.length > 0 ? 'name' : null,
    }
  },

  async searchByDevice(
    deviceId: string,
    limit: number,
  ): Promise<{ users: AdminUserSearchResultItem[]; matchedBy: AdminUserSearchMatchType | null }> {
    const userIds = (await adminUserSearchRepository.findUserIdsByDeviceId(deviceId)).slice(
      0,
      limit,
    )
    const rows = await adminUserSearchRepository.findByUserIds(userIds)
    const users = rows.map((row) => mapRow(row, 'deviceId'))
    return { users, matchedBy: users.length > 0 ? 'deviceId' : null }
  },
}
