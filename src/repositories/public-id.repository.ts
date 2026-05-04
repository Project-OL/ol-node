import { prisma } from '../config/database'
import { env } from '../config/env'

const SEQUENCE_ID = 1
const INITIAL_VALUE = 34216589

export const publicIdRepository = {
  async getNextAndIncrement(): Promise<bigint> {
    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.nextPublicIdSequence.findUnique({
        where: { id: SEQUENCE_ID },
      })
      if (!row) {
        await tx.nextPublicIdSequence.create({
          data: { id: SEQUENCE_ID, nextValue: BigInt(INITIAL_VALUE) },
        })
        return BigInt(INITIAL_VALUE)
      }
      const next = row.nextValue
      await tx.nextPublicIdSequence.update({
        where: { id: SEQUENCE_ID },
        data: { nextValue: { increment: 1 } },
      })
      return next
    })
    return result
  },

  async getCurrent(): Promise<bigint | null> {
    const row = await prisma.nextPublicIdSequence.findUnique({
      where: { id: SEQUENCE_ID },
    })
    return row?.nextValue ?? null
  },

  /** Next value the allocator would return, without consuming (read-only). */
  async peekNextValue(): Promise<bigint> {
    const row = await prisma.nextPublicIdSequence.findUnique({ where: { id: SEQUENCE_ID } })
    return row?.nextValue ?? env.PUBLIC_ID_INITIAL_VALUE
  },
}
