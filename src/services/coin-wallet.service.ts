import crypto from "crypto";
import { prisma } from "../config/database";
import { AppError } from "../middlewares/errorHandler";
import { walletRepository } from "../repositories/wallet.repository";
import { coinLedgerRepository } from "../repositories/coin-ledger.repository";
import { walletService } from "./wallet.service";
import { auditService } from "./audit.service";
import {
  WalletCurrencyType,
  CoinTxType,
  LedgerDirection,
  LevelType,
} from "@prisma/client";
import { walletLevelService } from "./user-level.service";

/** Coins debited when changing display name via PATCH /users/me (`name` field). */
export const USERNAME_CHANGE_COIN_COST = 10_000n;

export const coinWalletService = {
  /**
   * Any new **coin CREDIT** flow (VIP reward, transfer in, etc.) must call
   * `walletLevelService.applyCredit` inside the same `prisma.$transaction` as the ledger insert
   * and `refreshCache` after commit (see `confirmTopup`).
   */
  async listPackages() {
    return prisma.coinPackage.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  },

  async initiateTopup(
    userId: string,
    packageId: string,
    idempotencyKey: string,
  ) {
    const cached = await walletService.getCachedIdemResponse(idempotencyKey);
    if (cached) return cached;

    const acquired = await walletService.acquireIdemKey(idempotencyKey);
    if (!acquired)
      throw new AppError(409, "Request is already processing", "IDEM_CONFLICT");

    const pkg = await prisma.coinPackage.findFirst({
      where: { id: packageId, isActive: true },
    });
    if (!pkg) throw new AppError(404, "Package not found", "PACKAGE_NOT_FOUND");

    const order = await prisma.coinTopupOrder.create({
      data: {
        userId,
        packageId: pkg.id,
        coins: pkg.coins,
        priceCents: pkg.priceCents,
        currency: pkg.currency,
        idempotencyKey,
        status: "PENDING",
      },
    });

    const response = {
      orderId: order.id,
      coins: pkg.coins,
      priceCents: pkg.priceCents,
    };
    await walletService.resolveIdemKey(idempotencyKey, response);
    return response;
  },

  async confirmTopup(
    userId: string,
    orderId: string,
    gatewayRef: string,
    idempotencyKey: string,
  ) {
    const cached = await walletService.getCachedIdemResponse(idempotencyKey);
    if (cached) return cached;

    const acquired = await walletService.acquireIdemKey(idempotencyKey);
    if (!acquired)
      throw new AppError(409, "Request is already processing", "IDEM_CONFLICT");

    const order = await prisma.coinTopupOrder.findFirst({
      where: { id: orderId, userId, status: "PENDING" },
    });
    if (!order)
      throw new AppError(
        404,
        "Order not found or already processed",
        "ORDER_NOT_FOUND",
      );

    const wallet = await walletRepository.getOrCreate(
      userId,
      WalletCurrencyType.COIN,
    );

    const { ledgerEntry, levelResult } = await prisma.$transaction(
      async (tx) => {
        await walletRepository.lockForUpdate(tx, wallet.id);

        const last = await tx.coinLedgerEntry.findFirst({
          where: { walletId: wallet.id },
          orderBy: { createdAt: "desc" },
          select: { balanceAfter: true },
        });
        const currentBalance = last?.balanceAfter ?? 0n;
        const newBalance = currentBalance + BigInt(order.coins);

        const entry = await coinLedgerRepository.insert(tx, {
          walletId: wallet.id,
          direction: LedgerDirection.CREDIT,
          txType: CoinTxType.TOPUP,
          amount: BigInt(order.coins),
          balanceAfter: newBalance,
          refId: gatewayRef,
          description: `Top-up: ${order.coins} coins`,
          metadata: { packageId: order.packageId, orderId, gatewayRef },
          idempotencyKey,
        });

        await walletRepository.bumpVersion(tx, wallet.id);

        await tx.coinTopupOrder.update({
          where: { id: orderId },
          data: { status: "PAID", gatewayRef, ledgerEntryId: entry.id },
        });

        const lr = await walletLevelService.applyCredit(
          tx,
          userId,
          LevelType.WEALTH,
          BigInt(order.coins),
        );

        return { ledgerEntry: entry, levelResult: lr };
      },
      { isolationLevel: "Serializable" },
    );

    await walletService.adjustCoinBalanceCache(userId, BigInt(order.coins));

    const wealthSnapshot = await walletLevelService.refreshCache(
      userId,
      LevelType.WEALTH,
      levelResult.newCumulative,
      levelResult.newLevel,
      levelResult.previousLevel,
    );

    auditService.log({
      userId,
      actionType: "COIN_TOPUP_CONFIRMED",
      actionStatus: "success",
      actionDetails: { orderId, gatewayRef, coins: order.coins },
    });

    const response = {
      ledgerEntryId: ledgerEntry.id,
      coins: order.coins,
      balanceAfter: ledgerEntry.balanceAfter.toString(),
      wealthLevel: {
        currentLevel: wealthSnapshot.currentLevel,
        cumulativeTotal: wealthSnapshot.cumulativeTotal,
        distanceToUpgrade: wealthSnapshot.distanceToUpgrade,
        leveledUp: wealthSnapshot.leveledUp,
        previousLevel: wealthSnapshot.previousLevel,
      },
    };
    await walletService.resolveIdemKey(idempotencyKey, response);
    return response;
  },

  /**
   * Debits {@link USERNAME_CHANGE_COIN_COST} and updates first/last name + `usernameUpdatedAt`
   * in one DB transaction. Caller must ensure the display name actually changed.
   */
  async debitForDisplayNameChange(
    userId: string,
    firstName: string,
    lastName: string | null,
  ): Promise<void> {
    const wallet = await walletRepository.getOrCreate(
      userId,
      WalletCurrencyType.COIN,
    );
    const idempotencyKey = `username-change:${userId}:${crypto.randomUUID()}`;

    await prisma.$transaction(
      async (tx) => {
        await walletRepository.lockForUpdate(tx, wallet.id);

        const last = await tx.coinLedgerEntry.findFirst({
          where: { walletId: wallet.id },
          orderBy: { createdAt: "desc" },
          select: { balanceAfter: true },
        });
        const balance = last?.balanceAfter ?? 0n;
        if (balance < USERNAME_CHANGE_COIN_COST) {
          throw new AppError(
            402,
            "Not enough coins to change display name",
            "INSUFFICIENT_COINS",
            {
              required: USERNAME_CHANGE_COIN_COST.toString(),
              balance: balance.toString(),
            },
          );
        }

        // Use string literal so a stale Prisma Client (missing enum member) cannot pass `undefined`.
        await coinLedgerRepository.insert(tx, {
          walletId: wallet.id,
          direction: LedgerDirection.DEBIT,
          txType: "USERNAME_CHANGE" as CoinTxType,
          amount: USERNAME_CHANGE_COIN_COST,
          balanceAfter: balance - USERNAME_CHANGE_COIN_COST,
          description: "Display name change",
          metadata: { firstName, lastName },
          idempotencyKey,
        });
        await walletRepository.bumpVersion(tx, wallet.id);

        await tx.user.update({
          where: { id: userId },
          data: {
            firstName,
            lastName,
            usernameUpdatedAt: new Date(),
          },
        });
      },
      { isolationLevel: "Serializable" },
    );

    await walletService.adjustCoinBalanceCache(userId, USERNAME_CHANGE_COIN_COST);
  },

  async getHistory(
    userId: string,
    filter: {
      types?: CoinTxType[];
      from?: string;
      to?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    const wallet = await walletRepository.getOrCreate(
      userId,
      WalletCurrencyType.COIN,
    );

    const entries = await coinLedgerRepository.list({
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
