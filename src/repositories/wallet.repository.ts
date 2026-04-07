import { prisma } from "../config/database";
import { WalletCurrencyType, Prisma } from "@prisma/client";

export const walletRepository = {
  async getOrCreate(userId: string, currencyType: WalletCurrencyType) {
    return prisma.wallet.upsert({
      where: { userId_currencyType: { userId, currencyType } },
      create: { userId, currencyType },
      update: {},
    });
  },

  async lockForUpdate(tx: Prisma.TransactionClient, walletId: string) {
    // `wallets.id` is UUID; Prisma binds tagged-template params as text — cast for PG.
    const rows = await tx.$queryRaw<{ version: bigint }[]>`
      SELECT version FROM wallets WHERE id = ${walletId}::uuid FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async bumpVersion(tx: Prisma.TransactionClient, walletId: string) {
    return tx.wallet.update({
      where: { id: walletId },
      data: { version: { increment: 1 } },
    });
  },
};
