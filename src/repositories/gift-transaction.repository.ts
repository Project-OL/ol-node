import { Prisma } from "@prisma/client";

export const giftTransactionRepository = {
  async create(
    tx: Prisma.TransactionClient,
    data: {
      senderUserId: string;
      receiverUserId: string;
      giftId: string;
      coinCost: number;
      pointsAwarded: number;
      context: string;
    },
  ) {
    return tx.giftTransaction.create({ data });
  },
};
