import { prisma, prismaRead } from '../config/database'
import type { AdminRole, AdminStatus, Prisma } from '@prisma/client'

export interface AdminProfileData {
  username?: string | null
  phone?: string | null
  phoneCountryCode?: string | null
  gender?: string | null
  country?: string | null
}

export const systemAdminRepository = {
  async findByEmail(email: string) {
    return prismaRead.systemAdmin.findUnique({ where: { email } })
  },

  async findById(id: string) {
    return prismaRead.systemAdmin.findUnique({ where: { id } })
  },

  async findByUsername(username: string) {
    return prismaRead.systemAdmin.findUnique({ where: { username } })
  },

  async create(
    data: {
      email: string
      passwordHash: string
      displayName: string
      role: AdminRole
    } & AdminProfileData,
  ) {
    return prisma.systemAdmin.create({ data })
  },

  async findMany(filter: {
    role?: AdminRole
    status?: AdminStatus
    country?: string
    search?: string
    skip: number
    take: number
  }) {
    const where = buildAdminWhere(filter)
    const [items, total] = await Promise.all([
      prismaRead.systemAdmin.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      prismaRead.systemAdmin.count({ where }),
    ])
    return { items, total }
  },

  /** Unpaginated list for assignment pools and CSV export (bounded by caller). */
  async findAllByRole(role: AdminRole, status?: AdminStatus) {
    return prismaRead.systemAdmin.findMany({
      where: { role, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
    })
  },

  async update(id: string, data: AdminProfileData & { displayName?: string }) {
    return prisma.systemAdmin.update({ where: { id }, data })
  },

  async updatePasswordHash(id: string, passwordHash: string) {
    return prisma.systemAdmin.update({
      where: { id },
      data: {
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
      },
    })
  },

  /** Single writer for status — keeps the legacy isActive flag in sync. */
  async setStatus(id: string, status: AdminStatus) {
    return prisma.systemAdmin.update({
      where: { id },
      data: { status, isActive: status === 'ACTIVE' },
    })
  },

  async updateLastLogin(id: string) {
    return prisma.systemAdmin.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    })
  },

  async incrementFailedLogin(id: string) {
    return prisma.systemAdmin.update({
      where: { id },
      data: { failedLoginCount: { increment: 1 }, lastFailedLoginAt: new Date() },
    })
  },

  async resetFailedLogin(id: string) {
    return prisma.systemAdmin.update({
      where: { id },
      data: { failedLoginCount: 0, lockedUntil: null },
    })
  },

  async setLockedUntil(id: string, until: Date) {
    return prisma.systemAdmin.update({ where: { id }, data: { lockedUntil: until } })
  },

  /** @deprecated Route status changes through setStatus so status/isActive stay in sync. */
  async setActive(id: string, isActive: boolean) {
    return prisma.systemAdmin.update({ where: { id }, data: { isActive } })
  },

  async aggregateFailedLogins(role: AdminRole, since: Date) {
    const [failed, locked] = await Promise.all([
      prismaRead.systemAdmin.aggregate({
        where: { role, lastFailedLoginAt: { gt: since } },
        _sum: { failedLoginCount: true },
      }),
      prismaRead.systemAdmin.count({
        where: { role, lockedUntil: { gt: new Date() } },
      }),
    ])
    return { failedLoginAttempts: failed._sum.failedLoginCount ?? 0, lockedAccounts: locked }
  },

  /**
   * List CSA (or other role) accounts with recent failed logins and/or active lockouts.
   * Identity fields are on each row so ops can act on the specific admin.
   */
  async findFailedLoginAccounts(
    role: AdminRole,
    opts: { since: Date; includeLocked: boolean; skip: number; take: number },
  ) {
    const now = new Date()
    const or: Prisma.SystemAdminWhereInput[] = [{ lastFailedLoginAt: { gt: opts.since } }]
    if (opts.includeLocked) {
      or.push({ lockedUntil: { gt: now } })
    }
    const where: Prisma.SystemAdminWhereInput = { role, OR: or }
    const [items, total] = await Promise.all([
      prismaRead.systemAdmin.findMany({
        where,
        orderBy: [{ lockedUntil: 'desc' }, { lastFailedLoginAt: 'desc' }],
        skip: opts.skip,
        take: opts.take,
      }),
      prismaRead.systemAdmin.count({ where }),
    ])
    return { items, total }
  },

  async countByRoleAndStatus(role: AdminRole) {
    return prismaRead.systemAdmin.groupBy({
      by: ['status'],
      where: { role },
      _count: { _all: true },
    })
  },

  async createSession(data: {
    adminId: string
    tokenHash: string
    ipAddress?: string
    userAgent?: string
    expiresAt: Date
  }) {
    return prisma.adminSession.create({ data })
  },

  async findSessionById(id: string) {
    return prismaRead.adminSession.findFirst({
      where: { id, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { admin: true },
    })
  },

  async updateSessionTokenHash(id: string, tokenHash: string) {
    return prisma.adminSession.update({
      where: { id },
      data: { tokenHash },
    })
  },

  async revokeSession(id: string) {
    return prisma.adminSession.update({
      where: { id },
      data: { revokedAt: new Date() },
    })
  },

  async revokeAllSessions(adminId: string) {
    return prisma.adminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  },

  /** Revoke every active session except `exceptSessionId` (single-session admin login). */
  async revokeOtherSessions(adminId: string, exceptSessionId: string) {
    return prisma.adminSession.updateMany({
      where: { adminId, revokedAt: null, id: { not: exceptSessionId } },
      data: { revokedAt: new Date() },
    })
  },

  async listIpWhitelist(adminId: string) {
    return prismaRead.adminIpWhitelist.findMany({
      where: { adminId },
      orderBy: { createdAt: 'desc' },
    })
  },

  async findIpWhitelistEntry(adminId: string, whitelistId: string) {
    return prismaRead.adminIpWhitelist.findFirst({
      where: { id: whitelistId, adminId },
    })
  },

  async findIpWhitelistByAddress(adminId: string, ipAddress: string) {
    return prismaRead.adminIpWhitelist.findUnique({
      where: { adminId_ipAddress: { adminId, ipAddress } },
    })
  },

  async addIpWhitelist(data: {
    adminId: string
    ipAddress: string
    createdByAdminId?: string | null
  }) {
    return prisma.adminIpWhitelist.create({ data })
  },

  async addIpWhitelistMany(
    entries: Array<{ adminId: string; ipAddress: string; createdByAdminId?: string | null }>,
  ) {
    if (entries.length === 0) return { count: 0 }
    return prisma.adminIpWhitelist.createMany({ data: entries, skipDuplicates: true })
  },

  async removeIpWhitelist(whitelistId: string) {
    return prisma.adminIpWhitelist.delete({ where: { id: whitelistId } })
  },

  async countIpWhitelist(adminId: string) {
    return prismaRead.adminIpWhitelist.count({ where: { adminId } })
  },

  /** True when a row exists for this admin + normalized exact IP. */
  async isIpWhitelisted(adminId: string, ipAddress: string): Promise<boolean> {
    const row = await prismaRead.adminIpWhitelist.findUnique({
      where: { adminId_ipAddress: { adminId, ipAddress } },
      select: { id: true },
    })
    return row != null
  },
}

function buildAdminWhere(filter: {
  role?: AdminRole
  status?: AdminStatus
  country?: string
  search?: string
}): Prisma.SystemAdminWhereInput {
  const where: Prisma.SystemAdminWhereInput = {}
  if (filter.role) where.role = filter.role
  if (filter.status) where.status = filter.status
  if (filter.country) where.country = { equals: filter.country, mode: 'insensitive' }
  if (filter.search) {
    where.OR = [
      { displayName: { contains: filter.search, mode: 'insensitive' } },
      { username: { contains: filter.search, mode: 'insensitive' } },
      { email: { contains: filter.search, mode: 'insensitive' } },
      { phone: { contains: filter.search } },
    ]
  }
  return where
}
