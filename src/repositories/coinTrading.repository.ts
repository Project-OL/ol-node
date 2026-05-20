import { Prisma } from "@prisma/client";
import { prismaRead } from "../config/database";
import { walletRepository } from "./wallet.repository";
import { WalletCurrencyType } from "@prisma/client";
import { coinLedgerRepository } from "./coin-ledger.repository";

const transferUserSelect = {
  id: true,
  username: true,
  avatarUrl: true,
  publicId: true,
} as const;

export const coinTradingRepository = {
  getTopupRates() {
    return prismaRead.coinTradingTopupRate.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  },
  getTopupPackages() {
    return prismaRead.coinTradingTopupPackage.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  },
  getTopupPackageById(id: string) {
    return prismaRead.coinTradingTopupPackage.findFirst({
      where: { id, isActive: true },
    });
  },
  getExchangeRates() {
    return prismaRead.agentExchangeRate.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  },
  createTopupOrder(data: Prisma.CoinTradingTopupOrderUncheckedCreateInput, tx: Prisma.TransactionClient) {
    return tx.coinTradingTopupOrder.create({ data });
  },
  updateTopupOrder(
    data: { id: string; epayRef?: string; status?: string; ledgerEntryId?: string },
    tx: Prisma.TransactionClient,
  ) {
    return tx.coinTradingTopupOrder.update({
      where: { id: data.id },
      data: { epayRef: data.epayRef, status: data.status, ledgerEntryId: data.ledgerEntryId },
    });
  },
  getTopupOrderById(id: string) {
    return prismaRead.coinTradingTopupOrder.findUnique({ where: { id } });
  },
  getTopupOrderByEpayRef(ref: string) {
    return prismaRead.coinTradingTopupOrder.findUnique({ where: { epayRef: ref } });
  },
  createTransfer(data: Prisma.CoinTradingTransferUncheckedCreateInput, tx: Prisma.TransactionClient) {
    return tx.coinTradingTransfer.create({ data });
  },
  async reverseTransfer(params: { id: string; reversedByUserId: string; reason: string }, tx: Prisma.TransactionClient) {
    return tx.coinTradingTransfer.update({
      where: { id: params.id },
      data: { reversedAt: new Date(), reversedByUserId: params.reversedByUserId, reverseReason: params.reason },
    });
  },
  getTransferById(id: string) {
    return prismaRead.coinTradingTransfer.findUnique({ where: { id } });
  },
  listTopupOrders(agentUserId: string, opts: { limit: number; cursor?: string }) {
    return prismaRead.coinTradingTopupOrder.findMany({
      where: { agentUserId, ...(opts.cursor ? { id: { lt: opts.cursor } } : {}) },
      orderBy: { createdAt: "desc" },
      take: opts.limit + 1,
    });
  },
  listTransfers(params: {
    userId: string;
    role: "sender" | "recipient" | "all";
    direction?: "credit" | "debit";
    fromDate?: Date;
    toDate?: Date;
    limit: number;
    cursor?: string;
  }) {
    const roleFilter: Prisma.CoinTradingTransferWhereInput =
      params.role === "sender"
        ? { senderAgentUserId: params.userId }
        : params.role === "recipient"
          ? { recipientUserId: params.userId }
          : {
              OR: [
                { senderAgentUserId: params.userId },
                { recipientUserId: params.userId },
              ],
            };

    const and: Prisma.CoinTradingTransferWhereInput[] = [roleFilter];
    if (params.direction === "debit") {
      and.push({ senderAgentUserId: params.userId });
    }
    if (params.direction === "credit") {
      and.push({ recipientUserId: params.userId });
    }
    if (params.fromDate) {
      and.push({ createdAt: { gte: params.fromDate } });
    }
    if (params.toDate) {
      and.push({ createdAt: { lte: params.toDate } });
    }
    if (params.cursor) {
      and.push({ id: { lt: params.cursor } });
    }

    return prismaRead.coinTradingTransfer.findMany({
      where: { AND: and },
      orderBy: { createdAt: "desc" },
      take: params.limit + 1,
      include: {
        senderAgent: { select: transferUserSelect },
        recipient: { select: transferUserSelect },
      },
    });
  },
  async getRecentTransactionUsers(agencyUserId: string, limit = 10) {
    const rows = await prismaRead.$queryRaw<
      Array<{
        counterpartyId: string;
        lastTransactionAt: Date;
        direction: "sent" | "received";
      }>
    >`
      SELECT
        counterparty_id                               AS "counterpartyId",
        MAX(created_at)                               AS "lastTransactionAt",
        (CASE WHEN MAX(CASE WHEN is_sent THEN 1 ELSE 0 END) = 1 THEN 'sent' ELSE 'received' END)
                                                      AS direction
      FROM (
        SELECT recipient_user_id  AS counterparty_id, created_at, TRUE  AS is_sent
        FROM   coin_trading_transfers
        WHERE  sender_agent_user_id = ${agencyUserId}::uuid
          AND  reversed_at IS NULL

        UNION ALL

        SELECT sender_agent_user_id AS counterparty_id, created_at, FALSE AS is_sent
        FROM   coin_trading_transfers
        WHERE  recipient_user_id = ${agencyUserId}::uuid
          AND  reversed_at IS NULL
      ) t
      GROUP BY counterparty_id
      ORDER BY "lastTransactionAt" DESC
      LIMIT ${limit}
    `;

    if (rows.length === 0) return [];

    const userIds = rows.map((r) => r.counterpartyId);
    const users = await prismaRead.user.findMany({
      where: { id: { in: userIds } },
      select: transferUserSelect,
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return rows
      .map((row) => {
        const user = userMap.get(row.counterpartyId);
        if (!user) return null;
        return {
          id: user.id,
          name: user.username,
          avatarUrl: user.avatarUrl,
          publicId: user.publicId.toString(),
          lastTransactionAt: row.lastTransactionAt,
          lastDirection: row.direction,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r != null);
  },
  async getTradingBalance(userId: string) {
    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.TRADING_COIN);
    return coinLedgerRepository.computeBalance(wallet.id);
  },
};
