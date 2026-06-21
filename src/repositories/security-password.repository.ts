import { prisma, prismaRead } from '../config/database'
import type { SecurityPassword } from '@prisma/client'

export const securityPasswordRepository = {
  async findByUserId(userId: string): Promise<SecurityPassword | null> {
    return prismaRead.securityPassword.findUnique({
      where: { userId },
    })
  },

  async upsert(data: {
    userId: string
    passwordHash: string
    failedAttempts?: number
    lockedUntil?: Date | null
  }): Promise<SecurityPassword> {
    return prisma.securityPassword.upsert({
      where: { userId: data.userId },
      update: {
        passwordHash: data.passwordHash,
        failedAttempts: data.failedAttempts ?? 0,
        lastFailedAttemptAt: undefined,
        lockedUntil: data.lockedUntil ?? null,
      },
      create: {
        userId: data.userId,
        passwordHash: data.passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
      },
    })
  },

  async update(
    userId: string,
    data: Partial<{
      passwordHash: string
      failedAttempts: number
      lastFailedAttemptAt: Date
      lockedUntil: Date | null
    }>,
  ): Promise<SecurityPassword> {
    return prisma.securityPassword.update({
      where: { userId },
      data,
    })
  },

  async resetFailedAttempts(userId: string): Promise<void> {
    await prisma.securityPassword.update({
      where: { userId },
      data: { failedAttempts: 0, lockedUntil: null, lastFailedAttemptAt: null },
    })
  },

  async delete(userId: string): Promise<void> {
    await prisma.securityPassword.delete({ where: { userId } })
  },
}
