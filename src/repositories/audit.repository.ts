import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { isAdminActivityActionType } from '../utils/admin-audit'

export const auditRepository = {
  async log(data: {
    userId?: string | null
    adminUserId?: string | null
    actionType: string
    actionStatus: 'success' | 'failed'
    actionDetails?: Record<string, unknown> | null
    ipAddress?: string | null
    userAgent?: string | null
    deviceId?: string | null
  }) {
    return prisma.auditLog.create({
      data: {
        userId: data.userId ?? undefined,
        adminUserId: data.adminUserId ?? undefined,
        actionType: data.actionType,
        actionStatus: data.actionStatus,
        actionDetails: (data.actionDetails ?? undefined) as object | undefined,
        ipAddress: data.ipAddress ?? undefined,
        userAgent: data.userAgent ?? undefined,
        deviceId: data.deviceId ?? undefined,
      },
    })
  },

  async listAdminActivity(filter: {
    adminUserId?: string
    targetUserId?: string
    actionType?: string
    ipAddress?: string
    from?: Date
    to?: Date
    cursor?: string
    limit: number
  }) {
    const and: Prisma.AuditLogWhereInput[] = []

    // Admin activity scope
    and.push({
      OR: [
        { adminUserId: { not: null } },
        { actionType: { startsWith: 'ADMIN_' } },
        { actionType: 'WITHDRAWAL_MANUAL_ASSIGN' },
        { actionType: 'WITHDRAWAL_REVERSED' },
        { actionType: { startsWith: 'WITHDRAWAL_PLATFORM_' } },
        { actionType: { startsWith: 'WITHDRAWAL_DISPUTE_' } },
        { actionType: { startsWith: 'face_profile_' } },
        { actionType: { startsWith: 'face_duplicate_' } },
        {
          actionDetails: {
            path: ['adminUserId'],
            not: Prisma.DbNull,
          },
        },
      ],
    })

    if (filter.adminUserId) {
      and.push({
        OR: [
          { adminUserId: filter.adminUserId },
          {
            actionDetails: {
              path: ['adminUserId'],
              equals: filter.adminUserId,
            },
          },
        ],
      })
    }

    if (filter.targetUserId) {
      and.push({
        OR: [
          { userId: filter.targetUserId },
          {
            actionDetails: {
              path: ['targetUserId'],
              equals: filter.targetUserId,
            },
          },
        ],
      })
    }

    if (filter.actionType) {
      and.push({ actionType: filter.actionType })
    }

    if (filter.ipAddress?.trim()) {
      and.push({ ipAddress: { contains: filter.ipAddress.trim(), mode: 'insensitive' } })
    }

    if (filter.from || filter.to) {
      and.push({
        createdAt: {
          ...(filter.from ? { gte: filter.from } : {}),
          ...(filter.to ? { lte: filter.to } : {}),
        },
      })
    }

    if (filter.cursor) {
      const cursorRow = await prismaRead.auditLog.findUnique({
        where: { id: filter.cursor },
        select: { id: true, createdAt: true },
      })
      if (cursorRow) {
        and.push({
          OR: [
            { createdAt: { lt: cursorRow.createdAt } },
            { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
          ],
        })
      }
    }

    const where: Prisma.AuditLogWhereInput = { AND: and }
    const take = filter.limit + 1

    const rows = await prismaRead.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    })

    const hasMore = rows.length > filter.limit
    const page = hasMore ? rows.slice(0, filter.limit) : rows
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.id : null

    return { rows: page, nextCursor, hasMore }
  },

  async listDistinctAdminActionTypes(): Promise<string[]> {
    const rows = await prismaRead.auditLog.findMany({
      where: {
        OR: [
          { adminUserId: { not: null } },
          { actionType: { startsWith: 'ADMIN_' } },
        ],
      },
      distinct: ['actionType'],
      select: { actionType: true },
      orderBy: { actionType: 'asc' },
      take: 200,
    })
    return rows.map((r) => r.actionType).filter(isAdminActivityActionType)
  },
}
