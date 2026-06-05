import { prismaRead } from "../config/database";
import { PointTxType, LedgerDirection, Prisma } from "@prisma/client";

export type PointLedgerFilter = {
  walletId: string;
  types?: PointTxType[];
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
};

export const pointLedgerRepository = {
  async findByIdempotencyKey(
    tx: Prisma.TransactionClient,
    idempotencyKey: string,
  ) {
    return tx.pointLedgerEntry.findUnique({
      where: { idempotencyKey },
    });
  },

  async insert(
    tx: Prisma.TransactionClient,
    data: {
      walletId: string;
      direction: LedgerDirection;
      txType: PointTxType;
      amount: bigint;
      balanceAfter: bigint;
      refId?: string;
      counterpartyId?: string;
      description?: string;
      metadata?: object;
      idempotencyKey: string;
    },
  ) {
    return tx.pointLedgerEntry.create({ data });
  },

  async findByIdForWallet(entryId: string, walletId: string) {
    return prismaRead.pointLedgerEntry.findFirst({
      where: { id: entryId, walletId },
    });
  },

  /** All ledger rows for this wallet matching canonical business refId. */
  async findByRefForWallet(walletId: string, refId: string) {
    const byColumn = await prismaRead.pointLedgerEntry.findMany({
      where: { walletId, refId },
      orderBy: { createdAt: "desc" },
    });
    if (byColumn.length > 0) return byColumn;

    return prismaRead.pointLedgerEntry.findMany({
      where: {
        walletId,
        OR: [
          { metadata: { path: ["transferId"], equals: refId } },
          { metadata: { path: ["withdrawalId"], equals: refId } },
          { metadata: { path: ["subscriptionId"], equals: refId } },
          { metadata: { path: ["exchangeRefId"], equals: refId } },
        ],
      },
      orderBy: { createdAt: "desc" },
    });
  },

  async list(filter: PointLedgerFilter) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (filter.from) createdAt.gte = filter.from;
    if (filter.to) createdAt.lte = filter.to;
    if (filter.cursor) {
      createdAt.lt = await pointLedgerRepository._getCreatedAt(filter.cursor);
    }

    const where: Prisma.PointLedgerEntryWhereInput = {
      walletId: filter.walletId,
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
      ...(filter.types?.length ? { txType: { in: filter.types } } : {}),
    };

    return prismaRead.pointLedgerEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: filter.limit + 1,
      include: {
        wallet: { select: { userId: true } },
      },
    });
  },

  async computeBalance(walletId: string): Promise<bigint> {
    const credits = await prismaRead.pointLedgerEntry.aggregate({
      where: { walletId, direction: LedgerDirection.CREDIT },
      _sum: { amount: true },
    });
    const debits = await prismaRead.pointLedgerEntry.aggregate({
      where: {
        walletId,
        direction: LedgerDirection.DEBIT,
        // WITHDRAWAL_ESCROW is a SOFT marker (in-flight escrow). It does not
        // reduce the ledger sum (totalPoints); availability is derived separately
        // as totalPoints - wallets.unconfirmedPoints. The real debit happens at
        // settlement via WITHDRAWAL_ESCROW_SETTLED.
        txType: { not: PointTxType.WITHDRAWAL_ESCROW },
      },
      _sum: { amount: true },
    });
    return (credits._sum.amount ?? 0n) - (debits._sum.amount ?? 0n);
  },

  async _getCreatedAt(id: string): Promise<Date> {
    const e = await prismaRead.pointLedgerEntry.findUniqueOrThrow({
      where: { id },
      select: { createdAt: true },
    });
    return e.createdAt;
  },
};
