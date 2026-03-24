import { prisma } from '../config/database'

export const auditRepository = {
  async log(data: {
    userId?: string | null
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
        actionType: data.actionType,
        actionStatus: data.actionStatus,
        actionDetails: (data.actionDetails ?? undefined) as object | undefined,
        ipAddress: data.ipAddress ?? undefined,
        userAgent: data.userAgent ?? undefined,
        deviceId: data.deviceId ?? undefined,
      },
    })
  },
}
