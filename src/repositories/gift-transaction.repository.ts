import { Prisma } from "@prisma/client";

export const giftTransactionRepository = {
  async create(
    tx: Prisma.TransactionClient,
    data: {
      id?: string;
      senderUserId: string;
      receiverUserId: string;
      giftId: string;
      coinCost: number;
      pointsAwarded: number;
      context: string;
    },
  ) {
    const { id, ...rest } = data;
    return tx.giftTransaction.create({
      data: id ? { id, ...rest } : rest,
    });
  },
};
