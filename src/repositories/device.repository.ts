import { prisma, prismaRead } from '../config/database'
import type { DeviceLinkedAccount, DeviceRegistry, User } from '@prisma/client'

export interface LinkedAccountWithUser {
  userId: string
  publicId: number
  displayName: string
  avatarUrl: string | null
  linkedAt: Date
  lastUsedAt: Date
}

export const deviceRepository = {
  async findById(id: string): Promise<DeviceRegistry | null> {
    return prismaRead.deviceRegistry.findUnique({ where: { id } })
  },

  async findByUserId(userId: string): Promise<DeviceRegistry[]> {
    return prismaRead.deviceRegistry.findMany({
      where: { userId },
      orderBy: { lastActiveAt: 'desc' },
    })
  },

  async findByUserIdAndDeviceId(
    userId: string,
    deviceId: string,
  ): Promise<DeviceRegistry | null> {
    return prismaRead.deviceRegistry.findUnique({
      where: { userId_deviceId: { userId, deviceId } },
    })
  },

  /**
   * Count devices that have at least one active session (for remainingDevices).
   */
  async countWithActiveSessionByUserId(userId: string): Promise<number> {
    const sessions = await prismaRead.session.findMany({
      where: { userId, isActive: true, isRevoked: false },
      select: { deviceId: true },
      distinct: ['deviceId'],
    })
    return sessions.length
  },

  async update(
    id: string,
    data: Partial<Pick<DeviceRegistry, 'deviceName'>>,
  ): Promise<DeviceRegistry> {
    return prisma.deviceRegistry.update({ where: { id }, data })
  },

  async updateLastActive(userId: string, deviceId: string): Promise<void> {
    await prisma.deviceRegistry.updateMany({
      where: { userId, deviceId },
      data: { lastActiveAt: new Date() },
    })
  },

  async findLinkedAccounts(deviceId: string): Promise<LinkedAccountWithUser[]> {
    const rows = await prismaRead.deviceLinkedAccount.findMany({
      where: { deviceId },
      orderBy: { lastUsedAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            publicId: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
      },
    })

    return rows.map(
      (row: DeviceLinkedAccount & { user: Pick<User, 'id' | 'publicId' | 'username' | 'firstName' | 'lastName' | 'avatarUrl'> }) => {
        const { user } = row
        const fullName =
          user.firstName && user.lastName
            ? `${user.firstName} ${user.lastName}`
            : user.firstName ?? user.lastName
        const displayName = fullName && fullName.trim().length > 0 ? fullName : user.username

        return {
          userId: user.id,
          publicId: Number(user.publicId),
          displayName,
          avatarUrl: user.avatarUrl,
          linkedAt: row.linkedAt,
          lastUsedAt: row.lastUsedAt,
        }
      },
    )
  },

  async countLinkedAccounts(deviceId: string): Promise<number> {
    return prismaRead.deviceLinkedAccount.count({
      where: { deviceId },
    })
  },

  async upsertLinkedAccount(deviceId: string, userId: string): Promise<DeviceLinkedAccount> {
    const now = new Date()
    return prisma.deviceLinkedAccount.upsert({
      where: { deviceId_userId: { deviceId, userId } },
      update: { lastUsedAt: now },
      create: {
        deviceId,
        userId,
        linkedAt: now,
        lastUsedAt: now,
      },
    })
  },

  async deleteLinkedAccount(deviceId: string, userId: string): Promise<void> {
    await prisma.deviceLinkedAccount.delete({
      where: { deviceId_userId: { deviceId, userId } },
    })
  },
}
