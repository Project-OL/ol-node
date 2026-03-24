import { prisma } from '../config/database'

export const deviceRegistryRepository = {
  async upsert(data: {
    userId: string
    deviceId: string
    deviceName: string
    deviceType?: string | null
    platform?: string
    ipAddress?: string | null
    userAgent?: string | null
  }) {
    return prisma.deviceRegistry.upsert({
      where: { userId_deviceId: { userId: data.userId, deviceId: data.deviceId } },
      create: {
        userId: data.userId,
        deviceId: data.deviceId,
        deviceName: data.deviceName,
        deviceType: data.deviceType ?? undefined,
        platform: data.platform ?? 'web',
        ipAddress: data.ipAddress ?? undefined,
        userAgent: data.userAgent ?? undefined,
      },
      update: {
        deviceName: data.deviceName,
        deviceType: data.deviceType ?? undefined,
        platform: data.platform ?? undefined,
        ipAddress: data.ipAddress ?? undefined,
        userAgent: data.userAgent ?? undefined,
        lastActiveAt: new Date(),
      },
    })
  },

  async updateLastActive(userId: string, deviceId: string) {
    await prisma.deviceRegistry.updateMany({
      where: { userId, deviceId },
      data: { lastActiveAt: new Date() },
    })
  },
}
