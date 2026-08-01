import { Prisma } from '@prisma/client'

export const giftTransactionRepository = {
  async create(
    tx: Prisma.TransactionClient,
    data: {
      id?: string
      senderUserId: string
      receiverUserId: string
      giftId: string
      coinCost: number
      pointsAwarded: number
      context: string
      /** Combo quantity (default 1). One ledger row still; admin counts sum this. */
      quantity?: number
    },
  ) {
    const { id, quantity, ...rest } = data
    return tx.giftTransaction.create({
      data: id
        ? { id, ...rest, quantity: quantity ?? 1 }
        : { ...rest, quantity: quantity ?? 1 },
    })
  },
}
