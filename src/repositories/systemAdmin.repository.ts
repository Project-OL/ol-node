import { prisma, prismaRead } from '../config/database'
import type { AdminRole } from '@prisma/client'

export const systemAdminRepository = {
  async findByEmail(email: string) {
    return prismaRead.systemAdmin.findUnique({ where: { email } })
  },

  async findById(id: string) {
    return prismaRead.systemAdmin.findUnique({ where: { id } })
  },

  async create(data: {
    email: string
    passwordHash: string
    displayName: string
    role: AdminRole
  }) {
    return prisma.systemAdmin.create({ data })
  },

  async updateLastLogin(id: string) {
    return prisma.systemAdmin.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    })
  },

  async setActive(id: string, isActive: boolean) {
    return prisma.systemAdmin.update({ where: { id }, data: { isActive } })
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
}
