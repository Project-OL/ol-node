import { prisma, prismaRead } from '../config/database'
import type { Banner, Prisma } from '@prisma/client'

export type AdminBannerStatusFilter = 'active' | 'scheduled' | 'completed' | 'stopped' | 'all'

/**
 * Derived-status SQL filters. Precedence mirrors deriveBannerStatus():
 * completed = past endAt; stopped = disabled but not yet past endAt;
 * scheduled/active require enabled.
 */
function statusWhere(status: AdminBannerStatusFilter, now: Date): Prisma.BannerWhereInput {
  switch (status) {
    case 'active':
      return { enabled: true, startAt: { lte: now }, endAt: { gte: now } }
    case 'scheduled':
      return { enabled: true, startAt: { gt: now } }
    case 'completed':
      return { endAt: { lt: now } }
    case 'stopped':
      return { enabled: false, endAt: { gte: now } }
    case 'all':
      return {}
  }
}

export const bannerRepository = {
  create(data: {
    title: string
    imageUrl: string
    position: string
    startAt: Date
    endAt: Date
    enabled: boolean
    createdByAdminId?: string
  }): Promise<Banner> {
    return prisma.banner.create({ data })
  },

  findById(id: string): Promise<Banner | null> {
    return prisma.banner.findUnique({ where: { id } })
  },

  update(id: string, data: Prisma.BannerUpdateInput): Promise<Banner> {
    return prisma.banner.update({ where: { id }, data })
  },

  delete(id: string): Promise<Banner> {
    return prisma.banner.delete({ where: { id } })
  },

  /** Currently-live banners (enabled + inside window), optionally by position. */
  findActive(now: Date, position?: string, limit = 50): Promise<Banner[]> {
    return prismaRead.banner.findMany({
      where: {
        enabled: true,
        startAt: { lte: now },
        endAt: { gte: now },
        ...(position ? { position } : {}),
      },
      take: limit,
    })
  },

  async adminList(params: {
    status: AdminBannerStatusFilter
    position?: string
    page: number
    limit: number
    now: Date
  }): Promise<{ items: Banner[]; total: number }> {
    const where: Prisma.BannerWhereInput = {
      ...statusWhere(params.status, params.now),
      ...(params.position ? { position: params.position } : {}),
    }
    const [items, total] = await Promise.all([
      prismaRead.banner.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      prismaRead.banner.count({ where }),
    ])
    return { items, total }
  },
}
