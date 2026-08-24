import type { Prisma } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import {
  accountDeletionRepository,
  type AccountDeletionWithUser,
} from '../repositories/account-deletion.repository'
import type { AccountDeletionAdminListQuery } from '../models/account-deletion-admin.schemas'
import { accountDeletionService } from './account-deletion.service'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'

function pickContact(
  identifiers: AccountDeletionWithUser['user']['authIdentifiers'],
  provider: 'email' | 'phone',
): string | null {
  const matches = identifiers.filter((i) => i.provider === provider)
  const preferred =
    matches.find((i) => i.isVerified && i.isPrimary) ??
    matches.find((i) => i.isVerified) ??
    matches.find((i) => i.isPrimary) ??
    matches[0]
  return preferred?.identifier ?? null
}

function deriveStatus(row: AccountDeletionWithUser): 'open' | 'cancelled' | 'deleted' {
  if (row.isDeleted) return 'deleted'
  if (row.isCancelled) return 'cancelled'
  return 'open'
}

function serialize(row: AccountDeletionWithUser) {
  const now = Date.now()
  return {
    id: row.id,
    status: deriveStatus(row),
    scheduledAt: row.scheduledAt.toISOString(),
    deactivationUntil: row.deactivationUntil.toISOString(),
    deletionAt: row.deletionAt.toISOString(),
    canReactivate: !row.isCancelled && !row.isDeleted && row.deactivationUntil.getTime() > now,
    reminderSentAt: row.reminderSentAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    reason: row.reason ?? null,
    ipAddress: row.ipAddress ?? null,
    user: {
      userId: row.user.id,
      username: row.user.username,
      name: buildUserDisplayName(row.user),
      publicId: String(row.user.publicId),
      displayPublicId: resolveDisplayPublicId(row.user),
      status: row.user.status,
      avatarUrl: row.user.avatarUrl,
      email: pickContact(row.user.authIdentifiers, 'email'),
      phone: pickContact(row.user.authIdentifiers, 'phone'),
    },
  }
}

export const accountDeletionAdminService = {
  serialize,

  async list(query: AccountDeletionAdminListQuery) {
    const where: Prisma.AccountDeletionWhereInput = {}
    if (query.status === 'open') {
      where.isCancelled = false
      where.isDeleted = false
    } else if (query.status === 'cancelled') {
      where.isCancelled = true
    } else if (query.status === 'deleted') {
      where.isDeleted = true
    }

    if (query.q?.trim()) {
      const userIds = await accountDeletionRepository.resolveUserIdsByQuery({
        q: query.q,
        qType: query.qType,
      })
      if (userIds.length === 0) {
        return {
          page: query.page,
          limit: query.limit,
          total: 0,
          items: [] as ReturnType<typeof serialize>[],
        }
      }
      where.userId = { in: userIds }
    }

    const skip = (query.page - 1) * query.limit
    const { items, total } = await accountDeletionRepository.list({
      where,
      skip,
      take: query.limit,
    })

    return {
      page: query.page,
      limit: query.limit,
      total,
      items: items.map(serialize),
    }
  },

  async getById(id: string) {
    const row = await accountDeletionRepository.findByIdWithUser(id)
    if (!row) {
      throw new AppError(404, 'Account deletion request not found', 'ACCOUNT_DELETION_NOT_FOUND')
    }
    return serialize(row)
  },

  async cancel(id: string, adminUserId: string) {
    const result = await accountDeletionService.cancelDeletionByAdmin(id, adminUserId)
    const row = await accountDeletionRepository.findByIdWithUser(id)
    if (!row) {
      return {
        ...result,
        request: null,
      }
    }
    return {
      ...result,
      request: serialize(row),
    }
  },
}
