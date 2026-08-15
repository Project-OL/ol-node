import type { AdminLoginFailureReason, AdminRole } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export const adminLoginFailureRepository = {
  async create(data: {
    adminId: string
    email: string
    reason: AdminLoginFailureReason
    ipAddress?: string | null
    userAgent?: string | null
  }) {
    return prisma.adminLoginFailure.create({
      data: {
        adminId: data.adminId,
        email: data.email,
        reason: data.reason,
        ipAddress: data.ipAddress ?? undefined,
        userAgent: data.userAgent?.slice(0, 512) ?? undefined,
      },
    })
  },

  async countSince(since: Date, role?: AdminRole) {
    return prismaRead.adminLoginFailure.count({
      where: {
        createdAt: { gt: since },
        ...(role ? { admin: { role } } : {}),
      },
    })
  },

  async countByAdminIdsSince(adminIds: string[], since: Date): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    if (adminIds.length === 0) return map
    const rows = await prismaRead.adminLoginFailure.groupBy({
      by: ['adminId'],
      where: { adminId: { in: adminIds }, createdAt: { gt: since } },
      _count: { _all: true },
    })
    for (const row of rows) map.set(row.adminId, row._count._all)
    return map
  },

  async list(opts: {
    since: Date
    role?: AdminRole
    adminId?: string
    skip: number
    take: number
  }) {
    const where = {
      createdAt: { gt: opts.since },
      ...(opts.adminId ? { adminId: opts.adminId } : {}),
      ...(opts.role ? { admin: { role: opts.role } } : {}),
    }
    const [items, total] = await Promise.all([
      prismaRead.adminLoginFailure.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: {
          admin: { select: { id: true, email: true, displayName: true, role: true } },
        },
      }),
      prismaRead.adminLoginFailure.count({ where }),
    ])
    return { items, total }
  },
}
