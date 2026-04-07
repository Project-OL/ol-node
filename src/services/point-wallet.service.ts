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
  WithdrawalStatus,
  LevelType,
} from "@prisma/client";
import { walletLevelService } from "./user-level.service";
import { env } from "../config/env";
import { walletWithdrawalQueue } from "../queues/wallet-withdrawal.queue";

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

    const { entry, levelResult } = await prisma.$transaction(
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

        const lr = await walletLevelService.applyCredit(
          tx,
          userId,
          LevelType.LIVESTREAM,
          amount,
        );

        return { entry: e, levelResult: lr };
      },
      { isolationLevel: "Serializable" },
    );

    await walletService.adjustPointBalanceCache(userId, amount);

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
    idempotencyKey: string,
  ) {
    if (amountPoints < env.POINTS_WITHDRAW_MIN) {
      throw new AppError(
        400,
        `Minimum withdrawal is ${env.POINTS_WITHDRAW_MIN} points`,
        "BELOW_MIN_WITHDRAWAL",
      );
    }

    const cached = await walletService.getCachedIdemResponse(idempotencyKey);
    if (cached) return cached;

    const acquired = await walletService.acquireIdemKey(idempotencyKey);
    if (!acquired)
      throw new AppError(409, "Already processing", "IDEM_CONFLICT");

    const wallet = await walletRepository.getOrCreate(
      userId,
      WalletCurrencyType.POINT,
    );

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weeklyTotal = await prisma.withdrawal.aggregate({
      where: {
        userId,
        status: {
          in: [
            WithdrawalStatus.APPROVED,
            WithdrawalStatus.PROCESSING,
            WithdrawalStatus.PAID,
          ],
        },
        requestedAt: { gte: weekAgo },
      },
      _sum: { amountPoints: true },
    });
    const usedThisWeek = weeklyTotal._sum.amountPoints ?? 0n;
    if (usedThisWeek + amountPoints > env.POINTS_WITHDRAW_MAX_WEEKLY) {
      throw new AppError(
        400,
        "Weekly withdrawal limit exceeded",
        "WEEKLY_LIMIT_EXCEEDED",
      );
    }

    const withdrawal = await prisma.$transaction(
      async (tx) => {
        await walletRepository.lockForUpdate(tx, wallet.id);

        const last = await tx.pointLedgerEntry.findFirst({
          where: { walletId: wallet.id },
          orderBy: { createdAt: "desc" },
          select: { balanceAfter: true },
        });
        const currentBalance = last?.balanceAfter ?? 0n;
        if (currentBalance < amountPoints) {
          throw new AppError(400, "Insufficient points", "INSUFFICIENT_POINTS");
        }

        const newBalance = currentBalance - amountPoints;

        await pointLedgerRepository.insert(tx, {
          walletId: wallet.id,
          direction: LedgerDirection.DEBIT,
          txType: PointTxType.WITHDRAWAL,
          amount: amountPoints,
          balanceAfter: newBalance,
          description: "Withdrawal initiated",
          idempotencyKey,
        });

        await walletRepository.bumpVersion(tx, wallet.id);

        return tx.withdrawal.create({
          data: {
            walletId: wallet.id,
            userId,
            amountPoints,
            status: WithdrawalStatus.PENDING,
            idempotencyKey,
          },
        });
      },
      { isolationLevel: "Serializable" },
    );

    await walletService.adjustPointBalanceCache(userId, -amountPoints);

    auditService.log({
      userId,
      actionType: "POINTS_WITHDRAWAL_INITIATED",
      actionStatus: "success",
      actionDetails: {
        withdrawalId: withdrawal.id,
        amountPoints: amountPoints.toString(),
      },
    });

    await walletWithdrawalQueue.add(
      "process",
      { withdrawalId: withdrawal.id, userId },
      { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
    );

    const response = { withdrawalId: withdrawal.id, status: withdrawal.status };
    await walletService.resolveIdemKey(idempotencyKey, response);
    return response;
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
};
