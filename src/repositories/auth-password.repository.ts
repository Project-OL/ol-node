import { prisma } from '../config/database'

export const authPasswordRepository = {
  async create(userId: string, passwordHash: string) {
    return prisma.authPassword.create({
      data: { userId, passwordHash },
    })
  },

  async findByUserId(userId: string) {
    return prisma.authPassword.findUnique({
      where: { userId },
    })
  },

  async update(userId: string, passwordHash: string, previousHashes: string[] = []) {
    return prisma.authPassword.upsert({
      where: { userId },
      create: { userId, passwordHash, previousPasswordHashes: previousHashes },
      update: {
        passwordHash,
        previousPasswordHashes: previousHashes,
        lastChangedAt: new Date(),
      },
    })
  },

  async deleteByUserId(userId: string) {
    return prisma.authPassword.deleteMany({
      where: { userId },
    })
  },
}
