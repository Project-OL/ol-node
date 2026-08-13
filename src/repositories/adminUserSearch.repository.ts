import type { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

export const adminUserSearchSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
  status: true,
  isAgent: true,
  adminTags: true,
  avatarUrl: true,
  authIdentifiers: {
    where: { provider: { in: ['email', 'phone'] } },
    select: { provider: true, identifier: true, isPrimary: true },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.UserSelect

export type AdminUserSearchRow = Prisma.UserGetPayload<{ select: typeof adminUserSearchSelect }>

export const adminUserSearchRepository = {
  async findByUserId(userId: string): Promise<AdminUserSearchRow | null> {
    return prismaRead.user.findUnique({
      where: { id: userId },
      select: adminUserSearchSelect,
    })
  },

  async findByPublicId(publicId: bigint): Promise<AdminUserSearchRow | null> {
    return prismaRead.user.findFirst({
      where: {
        OR: [{ publicId }, { defaultPublicId: publicId }, { currentVipPublicId: publicId }],
      },
      select: adminUserSearchSelect,
    })
  },

  async findByEmail(email: string): Promise<AdminUserSearchRow | null> {
    const row = await prismaRead.authIdentifier.findFirst({
      where: {
        provider: 'email',
        identifier: { equals: email, mode: 'insensitive' },
      },
      select: { userId: true },
    })
    if (!row) return null
    return this.findByUserId(row.userId)
  },

  async findByPhone(phone: string): Promise<AdminUserSearchRow | null> {
    const row = await prismaRead.authIdentifier.findFirst({
      where: { provider: 'phone', identifier: phone },
      select: { userId: true },
    })
    if (!row) return null
    return this.findByUserId(row.userId)
  },

  async findUserIdsByDeviceId(deviceId: string): Promise<string[]> {
    const [registry, linked] = await Promise.all([
      prismaRead.deviceRegistry.findMany({
        where: { deviceId },
        select: { userId: true },
        distinct: ['userId'],
      }),
      prismaRead.deviceLinkedAccount.findMany({
        where: { deviceId },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ])
    return [...new Set([...registry.map((r) => r.userId), ...linked.map((l) => l.userId)])]
  },

  async findByUserIds(userIds: string[]): Promise<AdminUserSearchRow[]> {
    if (userIds.length === 0) return []
    return prismaRead.user.findMany({
      where: { id: { in: userIds } },
      select: adminUserSearchSelect,
      orderBy: { createdAt: 'desc' },
    })
  },

  async searchByName(query: string, limit: number): Promise<AdminUserSearchRow[]> {
    const q = query.trim()
    const or: Prisma.UserWhereInput[] = [
      { username: { contains: q, mode: 'insensitive' } },
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
    ]
    const spaceIdx = q.indexOf(' ')
    // "Jane Doe" → firstName contains Jane AND lastName contains Doe.
    // A single token like "Jane" already matches firstName (or lastName / username) above.
    if (spaceIdx > 0) {
      const first = q.slice(0, spaceIdx).trim()
      const last = q.slice(spaceIdx + 1).trim()
      if (first.length > 0 && last.length > 0) {
        or.push({
          AND: [
            { firstName: { contains: first, mode: 'insensitive' } },
            { lastName: { contains: last, mode: 'insensitive' } },
          ],
        })
      }
    }
    return prismaRead.user.findMany({
      where: { OR: or },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: adminUserSearchSelect,
    })
  },
}
