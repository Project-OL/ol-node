import { prisma } from '../config/database'

export interface UserSettingsUpdateData {
  language?: string
  allowMsgFromMutual?: boolean
  allowMsgFromFollowing?: boolean
  allowMsgFromStranger?: boolean
}

export const userSettingsRepository = {
  async findByUserId(userId: string) {
    return prisma.userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
    })
  },

  async upsertSettings(userId: string, data: UserSettingsUpdateData) {
    return prisma.userSettings.upsert({
      where: { userId },
      update: {
        ...data,
      },
      create: {
        userId,
        ...data,
      },
    })
  },
}

