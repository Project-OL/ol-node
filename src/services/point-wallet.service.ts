import type { Prisma } from "@prisma/client";
import { prisma, prismaRead } from "../config/database";
import { AppError } from "../middlewares/errorHandler";
import { walletRepository } from "../repositories/wallet.repository";
import { pointLedgerRepository } from "../repositories/point-ledger.repository";
import { walletService } from "./wallet.service";
import { auditService } from "./audit.service";
import {
  WalletCurrencyType,
  PointTxType,
  LedgerDirection,
  LevelType,
} from "@prisma/client";
import { walletLevelService } from "./user-level.service";
import { utcDayFromTimestamp } from "../utils/datetime";
import { withdrawalService } from "./withdrawal.service";

const INTERACTIVE_TX_TIMEOUT_MS = 20_000;

export const pointWalletService = {
  async getSummary(userId: string) {
    const balance = await walletService.getPointBalance(userId);

    const wallet = await walletRepository.getOrCreate(
      userId,
      WalletCurrencyType.POINT,
    );
    const earnings = await prismaRead.pointLedgerEntry.groupBy({
      by: ["txType"],
      where: { walletId: wallet.id, direction: LedgerDirection.CREDIT },
      _sum: { amount: true },
    });

    const earningsMap = Object.fromEntries(
      earnings.map((e) => [e.txType, (e._sum.amount ?? 0n).toString()]),
    ) as Partial<Record<PointTxType, string>>;

    return {
      remainingPoints: balance.toString(),
      earnings: {
        livestream: earningsMap.LIVESTREAM_GIFT ?? "0",
        commissions: earningsMap.COMMISSION ?? "0",
        transferPoints: earningsMap.TRANSFER_IN ?? "0",
        platformRewards: earningsMap.PLATFORM_REWARD ?? "0",
        subscription: earningsMap.SUBSCRIPTION ?? "0",
        mysteryChest: earningsMap.MYSTERY_CHEST ?? "0",
      },
    };
  },

  async creditPoints(params: {
    userId: string;
    amount: bigint;
    txType: PointTxType;
    refId?: string;
    counterpartyId?: string;
    description?: string;
    metadata?: object;
    idempotencyKey: string;
  }) {
    const {
      userId,
      amount,
      txType,
      refId,
      counterpartyId,
      description,
      metadata,
      idempotencyKey,
    } = params;

    const cached = await walletService.getCachedIdemResponse(idempotencyKey);
    if (cached) return cached;

    const acquired = await walletService.acquireIdemKey(idempotencyKey);
    if (!acquired)
      throw new AppError(409, "Already processing", "IDEM_CONFLICT");

    const wallet = await walletRepository.getOrCreate(
      userId,
      WalletCurrencyType.POINT,
    );

    const { entry, levelResult, bustAgentUserId } = await prisma.$transaction(
      async (tx) => {
        await walletRepository.lockForUpdate(tx, wallet.id);

        const last = await tx.pointLedgerEntry.findFirst({
          where: { walletId: wallet.id },
          orderBy: { createdAt: "desc" },
          select: { balanceAfter: true },
        });
        const newBalance = (last?.balanceAfter ?? 0n) + amount;

        const e = await pointLedgerRepository.insert(tx, {
          walletId: wallet.id,
          direction: LedgerDirection.CREDIT,
          txType,
          amount,
          balanceAfter: newBalance,
          refId,
          counterpartyId,
          description,
          metadata,
          idempotencyKey,
        });

        await walletRepository.bumpVersion(tx, wallet.id);

        const { agencyCommissionService } = await import(
          "./agencyCommission.service"
        );
        const ac = await agencyCommissionService.applyCommission(
          {
            hostUserId: userId,
            hostLedgerEntryId: e.id,
            hostPointsCredited: amount,
            hostTxType: txType,
            day: utcDayFromTimestamp(new Date()),
          },
          tx,
        );

        const lr = await walletLevelService.applyCredit(
          tx,
          userId,
          LevelType.LIVESTREAM,
          amount,
        );

        return {
          entry: e,
          levelResult: lr,
          bustAgentUserId: ac.bustAgentUserId,
        };
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_TIMEOUT_MS },
    );

    await walletService.adjustPointBalanceCache(userId, amount);

    if (bustAgentUserId) {
      const { agencyCommissionService } = await import(
        "./agencyCommission.service"
      );
      await agencyCommissionService.bustAgentCommissionCaches(bustAgentUserId);
    }

    const streamSnapshot = await walletLevelService.refreshCache(
      userId,
      LevelType.LIVESTREAM,
      levelResult.newCumulative,
      levelResult.newLevel,
      levelResult.previousLevel,
    );

    auditService.log({
      userId,
      actionType: "POINTS_CREDIT",
      actionStatus: "success",
      actionDetails: {
        ledgerEntryId: entry.id,
        txType,
        amount: amount.toString(),
        refId,
      },
    });

    const response = {
      ledgerEntryId: entry.id,
      balanceAfter: entry.balanceAfter.toString(),
      livestreamLevel: {
        currentLevel: streamSnapshot.currentLevel,
        cumulativeTotal: streamSnapshot.cumulativeTotal,
        distanceToUpgrade: streamSnapshot.distanceToUpgrade,
        leveledUp: streamSnapshot.leveledUp,
        previousLevel: streamSnapshot.previousLevel,
      },
    };
    await walletService.resolveIdemKey(idempotencyKey, response);
    return response;
  },

  async initiateWithdrawal(
    userId: string,
    amountPoints: bigint,
    paymentMethodId: string,
    idempotencyKey: string,
    notes?: string,
  ) {
    const result = (await withdrawalService.createWithdrawal(userId, {
      grossPoints: amountPoints,
      paymentMethodId,
      idempotencyKey,
      notes,
    })) as { withdrawalId: string; status: string };

    auditService.log({
      userId,
      actionType: "POINTS_WITHDRAWAL_INITIATED",
      actionStatus: "success",
      actionDetails: {
        withdrawalId: result.withdrawalId,
        amountPoints: amountPoints.toString(),
      },
    });

    return result;
  },

  async getHistory(
    userId: string,
    filter: {
      types?: PointTxType[];
      from?: string;
      to?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    const wallet = await walletRepository.getOrCreate(
      userId,
      WalletCurrencyType.POINT,
    );

    const entries = await pointLedgerRepository.list({
      walletId: wallet.id,
      types: filter.types,
      from: filter.from ? new Date(filter.from) : undefined,
      to: filter.to ? new Date(filter.to) : undefined,
      cursor: filter.cursor,
      limit: filter.limit,
    });

    const hasMore = entries.length > filter.limit;
    const page = hasMore ? entries.slice(0, filter.limit) : entries;
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

    return {
      entries: page.map((e) => ({
        id: e.id,
        direction: e.direction,
        txType: e.txType,
        amount: e.amount.toString(),
        balanceAfter: e.balanceAfter.toString(),
        refId: e.refId,
        counterpartyId: e.counterpartyId,
        description: e.description,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
      nextCursor,
      hasMore,
    };
  },

  /**
   * Point credit inside a caller-owned transaction. Idempotent on `idempotencyKey`.
   * When `applyLivestreamLevel` is true (default), applies livestream cumulative XP
   * (host earnings). Set false for agent commission / internal transfers.
   */
  async creditInTransaction(
    userId: string,
    amount: bigint,
    txType: PointTxType,
    tx: Prisma.TransactionClient,
    options: {
      idempotencyKey: string;
      refId?: string;
      counterpartyId?: string;
      description?: string;
      metadata?: Prisma.JsonValue;
      applyLivestreamLevel?: boolean;
    },
  ): Promise<{ ledgerEntryId: string; balanceAfter: bigint }> {
    const existing = await pointLedgerRepository.findByIdempotencyKey(
      tx,
      options.idempotencyKey,
    );
    if (existing) {
      return {
        ledgerEntryId: existing.id,
        balanceAfter: existing.balanceAfter,
      };
    }

    const wallet = await tx.wallet.upsert({
      where: {
        userId_currencyType: {
          userId,
          currencyType: WalletCurrencyType.POINT,
        },
      },
      create: { userId, currencyType: WalletCurrencyType.POINT },
      update: {},
    });
    await walletRepository.lockForUpdate(tx, wallet.id);
    const last = await tx.pointLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    });
    const newBalance = (last?.balanceAfter ?? 0n) + amount;

    const entry = await pointLedgerRepository.insert(tx, {
      walletId: wallet.id,
      direction: LedgerDirection.CREDIT,
      txType,
      amount,
      balanceAfter: newBalance,
      refId: options.refId,
      counterpartyId: options.counterpartyId,
      description: options.description ?? undefined,
      metadata: options.metadata as object | undefined,
      idempotencyKey: options.idempotencyKey,
    });
    await walletRepository.bumpVersion(tx, wallet.id);

    const applyCommission =
      txType === PointTxType.LIVESTREAM_GIFT ||
      txType === PointTxType.GIFT_RECEIVE ||
      txType === PointTxType.VIDEO_CALL ||
      txType === PointTxType.SUBSCRIPTION;

    if (applyCommission) {
      const { agencyCommissionService } = await import(
        "./agencyCommission.service"
      );
      await agencyCommissionService.applyCommission(
        {
          hostUserId: userId,
          hostLedgerEntryId: entry.id,
          hostPointsCredited: amount,
          hostTxType: txType,
          day: utcDayFromTimestamp(new Date()),
        },
        tx,
      );
    }

    const applyXp = options.applyLivestreamLevel !== false;
    if (
      applyXp &&
      txType !== PointTxType.AGENT_COMMISSION &&
      txType !== PointTxType.AGENT_POINT_TRANSFER
    ) {
      await walletLevelService.applyCredit(
        tx,
        userId,
        LevelType.LIVESTREAM,
        amount,
      );
    }

    return { ledgerEntryId: entry.id, balanceAfter: entry.balanceAfter };
  },

  /**
   * Generic point debit inside a caller-owned Serializable transaction.
   * Idempotent on `idempotencyKey`. Does not apply livestream XP (penalties / adjustments).
   */
  async debit(
    userId: string,
    amount: bigint,
    txType: PointTxType,
    tx: Prisma.TransactionClient,
    options: {
      idempotencyKey: string;
      description?: string;
      metadata?: Prisma.JsonValue;
      counterpartyId?: string;
      refId?: string;
    },
  ): Promise<{ ledgerEntryId: string; balanceAfter: bigint }> {
    const existing = await pointLedgerRepository.findByIdempotencyKey(
      tx,
      options.idempotencyKey,
    );
    if (existing) {
      return {
        ledgerEntryId: existing.id,
        balanceAfter: existing.balanceAfter,
      };
    }

    const wallet = await tx.wallet.upsert({
      where: {
        userId_currencyType: {
          userId,
          currencyType: WalletCurrencyType.POINT,
        },
      },
      create: { userId, currencyType: WalletCurrencyType.POINT },
      update: {},
    });
    await walletRepository.lockForUpdate(tx, wallet.id);
    const last = await tx.pointLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    });
    const balance = last?.balanceAfter ?? 0n;
    if (balance < amount) {
      throw new AppError(400, "Insufficient points", "INSUFFICIENT_POINTS", {
        balance: balance.toString(),
        required: amount.toString(),
      });
    }

    const entry = await pointLedgerRepository.insert(tx, {
      walletId: wallet.id,
      direction: LedgerDirection.DEBIT,
      txType,
      amount,
      balanceAfter: balance - amount,
      refId: options.refId,
      counterpartyId: options.counterpartyId,
      description: options.description,
      metadata: options.metadata as object | undefined,
      idempotencyKey: options.idempotencyKey,
    });
    await walletRepository.bumpVersion(tx, wallet.id);
    return { ledgerEntryId: entry.id, balanceAfter: entry.balanceAfter };
  },
};
