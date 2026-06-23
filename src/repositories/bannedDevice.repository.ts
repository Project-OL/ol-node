import { prisma, prismaRead } from '../config/database'

type BannedDeviceRow = {
  deviceId: string
  reason: string | null
  bannedByAdminId: string | null
  relatedUserId: string | null
  bannedAt: Date
}

const bannedDeviceClient = prisma as typeof prisma & {
  bannedDevice: {
    findUnique: (args: { where: { deviceId: string } }) => Promise<BannedDeviceRow | null>
    upsert: (args: {
      where: { deviceId: string }
      create: Omit<BannedDeviceRow, 'bannedAt'> & { bannedAt?: Date }
      update: Partial<BannedDeviceRow>
    }) => Promise<BannedDeviceRow>
    deleteMany: (args: { where: { deviceId: string } }) => Promise<{ count: number }>
    findMany: (args: {
      where: { relatedUserId: string }
      orderBy: { bannedAt: 'desc' }
    }) => Promise<BannedDeviceRow[]>
  }
}

const bannedDeviceRead = prismaRead as typeof prismaRead & {
  bannedDevice: {
    findUnique: (args: { where: { deviceId: string } }) => Promise<BannedDeviceRow | null>
    findMany: (args: {
      where: { relatedUserId: string }
      orderBy: { bannedAt: 'desc' }
    }) => Promise<BannedDeviceRow[]>
  }
}

export const bannedDeviceRepository = {
  async findByDeviceId(deviceId: string) {
    return bannedDeviceRead.bannedDevice.findUnique({ where: { deviceId } })
  },

  async ban(data: {
    deviceId: string
    reason?: string | null
    bannedByAdminId?: string | null
    relatedUserId?: string | null
  }) {
    return bannedDeviceClient.bannedDevice.upsert({
      where: { deviceId: data.deviceId },
      create: {
        deviceId: data.deviceId,
        reason: data.reason ?? null,
        bannedByAdminId: data.bannedByAdminId ?? null,
        relatedUserId: data.relatedUserId ?? null,
      },
      update: {
        reason: data.reason ?? null,
        bannedByAdminId: data.bannedByAdminId ?? null,
        relatedUserId: data.relatedUserId ?? null,
        bannedAt: new Date(),
      },
    })
  },

  async unban(deviceId: string) {
    return bannedDeviceClient.bannedDevice.deleteMany({ where: { deviceId } })
  },

  async listByRelatedUserId(userId: string) {
    return bannedDeviceRead.bannedDevice.findMany({
      where: { relatedUserId: userId },
      orderBy: { bannedAt: 'desc' },
    })
  },
}
