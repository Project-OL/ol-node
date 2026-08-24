import { AppError } from '../middlewares/errorHandler'
import { normalizePhone } from '../lib/utils/phone.util'
import type { AdminUserSearchQuery } from '../models/admin-user-search.schemas'
import {
  adminUserSearchRepository,
  type AdminUserSearchRow,
} from '../repositories/adminUserSearch.repository'
import {
  ADMIN_USER_SEARCH_HISTORY_MAX,
  ADMIN_USER_SEARCH_HISTORY_TTL,
  redisClient,
  RedisKeys,
} from '../config/redis'
import { formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import {
  ADMIN_USER_SEARCH_UUID_RE,
  resolveAdminUserSearchAutoType,
} from '../utils/admin-user-search-type'
import { storeAdminService } from './store-admin.service'

export type AdminUserSearchMatchType =
  | 'userId'
  | 'publicId'
  | 'email'
  | 'phone'
  | 'deviceId'
  | 'name'

export interface AdminUserSearchResultItem {
  userId: string
  firstName: string | null
  lastName: string | null
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
  store?: Awaited<ReturnType<typeof storeAdminService.getUserStoreSummary>>
}

export interface AdminUserSearchHistoryItem {
  userId: string
  firstName: string | null
  lastName: string | null
  name: string
  username: string
  publicId: string
  displayPublicId: string
  status: string
  avatarUrl: string | null
  isAgent: boolean
  adminTags: string[]
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
    firstName: row.firstName,
    lastName: row.lastName,
    name: formatUserName(row),
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

export const adminUserSearchService = {
  /**
   * Push a user to the top of this admin's recent-search history (max 10, per admin).
   * Dedupes by userId. Failures are swallowed — history is best-effort.
   */
  async recordHistory(adminUserId: string, user: { userId: string } | string): Promise<void> {
    const userId = typeof user === 'string' ? user : user.userId
    if (!userId) return
    const key = RedisKeys.adminUserSearchHistory(adminUserId)
    try {
      const pipe = redisClient.pipeline()
      pipe.lrem(key, 0, userId)
      pipe.lpush(key, userId)
      pipe.ltrim(key, 0, ADMIN_USER_SEARCH_HISTORY_MAX - 1)
      pipe.expire(key, ADMIN_USER_SEARCH_HISTORY_TTL)
      await pipe.exec()
    } catch {
      // best-effort
    }
  },

  async getHistory(adminUserId: string): Promise<{ users: AdminUserSearchHistoryItem[] }> {
    const key = RedisKeys.adminUserSearchHistory(adminUserId)
    let userIds: string[] = []
    try {
      userIds = await redisClient.lrange(key, 0, ADMIN_USER_SEARCH_HISTORY_MAX - 1)
    } catch {
      return { users: [] }
    }
    if (userIds.length === 0) return { users: [] }

    const rows = await adminUserSearchRepository.findByUserIds(userIds)
    const byId = new Map(rows.map((r) => [r.id, r]))
    const users: AdminUserSearchHistoryItem[] = []
    for (const id of userIds) {
      const row = byId.get(id)
      if (!row) continue
      users.push({
        userId: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        name: formatUserName(row),
        username: row.username,
        publicId: String(row.publicId),
        displayPublicId: resolveDisplayPublicId(row),
        status: row.status,
        avatarUrl: row.avatarUrl,
        isAgent: row.isAgent,
        adminTags: row.adminTags,
      })
    }
    return { users }
  },

  async search(
    params: AdminUserSearchQuery,
    opts?: { adminUserId?: string },
  ): Promise<{
    users: AdminUserSearchResultItem[]
    matchedBy: AdminUserSearchMatchType | null
  }> {
    const query = params.q.trim()
    const effectiveType =
      params.type === 'auto' ? resolveAdminUserSearchAutoType(query) : params.type
    const includeStore = params.includeStore ?? true

    const attachStore = async (result: {
      users: AdminUserSearchResultItem[]
      matchedBy: AdminUserSearchMatchType | null
    }) => {
      if (!includeStore || result.users.length === 0) return result
      const summaries = await storeAdminService.getUserStoreSummaries(
        result.users.map((u) => u.userId),
      )
      return {
        matchedBy: result.matchedBy,
        users: result.users.map((user) => ({
          ...user,
          store: summaries.get(user.userId),
        })),
      }
    }

    const maybeRecordExact = async (result: {
      users: AdminUserSearchResultItem[]
      matchedBy: AdminUserSearchMatchType | null
    }) => {
      if (
        opts?.adminUserId &&
        result.users.length === 1 &&
        result.matchedBy &&
        result.matchedBy !== 'name'
      ) {
        await this.recordHistory(opts.adminUserId, result.users[0]!.userId)
      }
      return result
    }

    if (effectiveType === 'name' && query.length < 2) {
      throw new AppError(400, 'Name search requires at least 2 characters', 'INVALID_REQUEST')
    }

    if (effectiveType === 'userId') {
      if (!ADMIN_USER_SEARCH_UUID_RE.test(query)) {
        throw new AppError(400, 'Invalid user id (UUID expected)', 'INVALID_REQUEST')
      }
      const row = await adminUserSearchRepository.findByUserId(query)
      if (row) {
        return maybeRecordExact(
          await attachStore({
            users: [mapRow(row, 'userId')],
            matchedBy: 'userId',
          }),
        )
      }
      if (params.type === 'auto') {
        return maybeRecordExact(await this.searchByDevice(query, params.limit, includeStore))
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
      return maybeRecordExact(
        await attachStore({
          users: row ? [mapRow(row, 'publicId')] : [],
          matchedBy: row ? 'publicId' : null,
        }),
      )
    }

    if (effectiveType === 'email') {
      const row = await adminUserSearchRepository.findByEmail(query.toLowerCase())
      return maybeRecordExact(
        await attachStore({
          users: row ? [mapRow(row, 'email')] : [],
          matchedBy: row ? 'email' : null,
        }),
      )
    }

    if (effectiveType === 'phone') {
      const normalized = normalizePhone(query)
      if (!normalized) {
        throw new AppError(400, 'Invalid phone number', 'INVALID_PHONE')
      }
      const row = await adminUserSearchRepository.findByPhone(normalized)
      return maybeRecordExact(
        await attachStore({
          users: row ? [mapRow(row, 'phone')] : [],
          matchedBy: row ? 'phone' : null,
        }),
      )
    }

    if (effectiveType === 'deviceId') {
      const deviceResult = await maybeRecordExact(
        await this.searchByDevice(query, params.limit, includeStore),
      )
      if (params.type === 'auto' && deviceResult.users.length === 0) {
        const rows = await adminUserSearchRepository.searchByName(query, params.limit)
        return attachStore({
          users: rows.map((row) => mapRow(row, 'name')),
          matchedBy: rows.length > 0 ? 'name' : null,
        })
      }
      return deviceResult
    }

    const rows = await adminUserSearchRepository.searchByName(query, params.limit)
    return attachStore({
      users: rows.map((row) => mapRow(row, 'name')),
      matchedBy: rows.length > 0 ? 'name' : null,
    })
  },

  async searchByDevice(
    deviceId: string,
    limit: number,
    includeStore = true,
  ): Promise<{ users: AdminUserSearchResultItem[]; matchedBy: AdminUserSearchMatchType | null }> {
    const userIds = (await adminUserSearchRepository.findUserIdsByDeviceId(deviceId)).slice(
      0,
      limit,
    )
    const rows = await adminUserSearchRepository.findByUserIds(userIds)
    const users = rows.map((row) => mapRow(row, 'deviceId'))
    if (!includeStore || users.length === 0) {
      return { users, matchedBy: users.length > 0 ? 'deviceId' : null }
    }
    const summaries = await storeAdminService.getUserStoreSummaries(users.map((u) => u.userId))
    return {
      users: users.map((user) => ({
        ...user,
        store: summaries.get(user.userId),
      })),
      matchedBy: users.length > 0 ? 'deviceId' : null,
    }
  },
}
