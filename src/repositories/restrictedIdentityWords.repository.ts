import { prisma } from '../config/database'

export const restrictedIdentityWordsRepository = {
  async count() {
    return prisma.bannedWord.count()
  },

  async listActive() {
    return prisma.bannedWord.findMany({
      where: { isActive: true },
      orderBy: { word: 'asc' },
      select: { word: true },
    })
  },

  async listAll() {
    return prisma.bannedWord.findMany({
      orderBy: { word: 'asc' },
      select: { id: true, word: true, isActive: true, updatedAt: true },
    })
  },

  async insertMissing(words: readonly string[]) {
    if (words.length === 0) return
    await prisma.bannedWord.createMany({
      data: words.map((word) => ({ word, isActive: true })),
      skipDuplicates: true,
    })
  },

  async replaceAll(words: readonly string[]) {
    await prisma.$transaction(async (tx) => {
      if (words.length === 0) {
        // Keep rows so first-GET seed does not run again after an intentional clear.
        await tx.bannedWord.updateMany({ data: { isActive: false } })
        return
      }
      await tx.bannedWord.deleteMany({ where: { word: { notIn: [...words] } } })
      for (const word of words) {
        await tx.bannedWord.upsert({
          where: { word },
          create: { word, isActive: true },
          update: { isActive: true },
        })
      }
    })
  },
}
