import { prisma } from '../config/database'

export const classificationProgressRepository = {
  async get(): Promise<bigint> {
    const row = await prisma.publicIdClassificationProgress.findUnique({ where: { id: 1 } })
    if (!row) throw new Error('classification progress row missing — run migration')
    return row.lastClassifiedId
  },

  /**
   * Advance cursor to at least `value` (monotonic). Parallel horizon runs cannot lower the checkpoint.
   */
  async set(value: bigint): Promise<void> {
    await prisma.$executeRaw`
      UPDATE public_id_classification_progress
      SET last_classified_id = GREATEST(last_classified_id, ${value}),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `
  },
}
