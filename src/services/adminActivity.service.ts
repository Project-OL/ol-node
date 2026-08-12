import { auditRepository } from '../repositories/audit.repository'
import { adminTransactionsRepository } from '../repositories/admin-transactions.repository'
import { systemAdminRepository } from '../repositories/systemAdmin.repository'
import type { AdminActivityListQuery } from '../models/admin-activity.schemas'
import { buildUserDisplayName, formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import { resolveAdminActivityDestination } from '../utils/admin-audit'

type AdminBrief = {
  adminUserId: string
  email: string
  displayName: string
  role: string
}

type UserBrief = {
  userId: string
  username: string
  name: string
  displayName: string
  publicId: string
  displayPublicId: string
  avatarUrl: string | null
}

function mapAdminBrief(a: {
  id: string
  email: string
  displayName: string
  role: string
}): AdminBrief {
  return {
    adminUserId: a.id,
    email: a.email,
    displayName: a.displayName,
    role: a.role,
  }
}

function mapUserBrief(u: {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  avatarUrl: string | null
}): UserBrief {
  return {
    userId: u.id,
    username: u.username,
    name: formatUserName(u),
    displayName: buildUserDisplayName(u),
    publicId: String(u.publicId),
    displayPublicId: resolveDisplayPublicId(u),
    avatarUrl: u.avatarUrl,
  }
}

function resolveAdminIdFromRow(row: {
  adminUserId: string | null
  actionDetails: unknown
}): string | null {
  if (row.adminUserId) return row.adminUserId
  const d = row.actionDetails as Record<string, unknown> | null
  const legacy = d?.adminUserId
  return typeof legacy === 'string' ? legacy : null
}

export const adminActivityService = {
  async listActionTypes() {
    const types = await auditRepository.listDistinctAdminActionTypes()
    return { actionTypes: types }
  },

  async list(query: AdminActivityListQuery) {
    const { rows, nextCursor, hasMore } = await auditRepository.listAdminActivity({
      adminUserId: query.adminUserId,
      targetUserId: query.targetUserId,
      actionType: query.actionType,
      ipAddress: query.ipAddress,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    })

    const adminIds = [
      ...new Set(rows.map((r) => resolveAdminIdFromRow(r)).filter((id): id is string => !!id)),
    ]
    const userIds = [
      ...new Set(
        rows
          .map((r) => {
            const dest = resolveAdminActivityDestination(r.actionType, r.actionDetails)
            return r.userId ?? dest.targetUserId
          })
          .filter((id): id is string => !!id),
      ),
    ]

    const [admins, users] = await Promise.all([
      Promise.all(adminIds.map((id) => systemAdminRepository.findById(id))),
      adminTransactionsRepository.findUsersByIds(userIds),
    ])
    const adminMap = new Map(
      admins.filter(Boolean).map((a) => [a!.id, mapAdminBrief(a!)]),
    )
    const userMap = new Map(users.map((u) => [u.id, mapUserBrief(u)]))

    return {
      entries: rows.map((row) => {
        const adminId = resolveAdminIdFromRow(row)
        const destination = resolveAdminActivityDestination(row.actionType, row.actionDetails)
        const storedDestination =
          row.actionDetails &&
          typeof row.actionDetails === 'object' &&
          !Array.isArray(row.actionDetails) &&
          typeof (row.actionDetails as Record<string, unknown>).destination === 'string'
            ? String((row.actionDetails as Record<string, unknown>).destination)
            : null
        const targetUserId = row.userId ?? destination.targetUserId

        return {
          id: row.id,
          actionType: row.actionType,
          actionStatus: row.actionStatus,
          createdAt: row.createdAt.toISOString(),
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          deviceId: row.deviceId,
          admin: adminId ? (adminMap.get(adminId) ?? null) : null,
          targetUser: targetUserId ? (userMap.get(targetUserId) ?? null) : null,
          destination: {
            label: storedDestination ?? destination.label,
            resourceType: destination.resourceType,
            resourceId: destination.resourceId,
          },
          actionDetails: row.actionDetails,
        }
      }),
      nextCursor,
      hasMore,
    }
  },
}
