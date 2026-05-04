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
  type Prisma,
} from "@prisma/client";
import { walletLevelService } from "./user-level.service";
import {
  RECHARGE_TX_TYPES,
  richTierService,
} from "./rich-tier.service";

/** Coins debited when changing display name via PATCH /users/me (`name` field). */
export const USERNAME_CHANGE_COIN_COST = 10_000n;
const INTERACTIVE_TX_TIMEOUT_MS = 20_000;

export const coinWalletService = {
  /**
   * Any new **coin CREDIT** flow (VIP reward, transfer in, etc.) must call
   * `walletLevelService.applyCredit` inside the same `prisma.$transaction` as the ledger insert
   * and `refreshCache` after commit (see `confirmTopup`). Flows in `RECHARGE_TX_TYPES` must also
   * call `richTierService.applyRecharge` in-tx and `refreshCacheAfterRecharge` after commit.
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

    const txType = CoinTxType.TOPUP;

    const { ledgerEntry, levelResult, richTierMonth } =
      await prisma.$transaction(
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
            txType,
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

          const richMonth = RECHARGE_TX_TYPES.has(txType)
            ? await richTierService.applyRecharge(
                userId,
                BigInt(order.coins),
                tx,
              )
            : null;

          return {
            ledgerEntry: entry,
            levelResult: lr,
            richTierMonth: richMonth,
          };
        },
        { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_TIMEOUT_MS },
      );

    await walletService.adjustCoinBalanceCache(userId, BigInt(order.coins));

    const wealthSnapshot = await walletLevelService.refreshCache(
      userId,
      LevelType.WEALTH,
      levelResult.newCumulative,
      levelResult.newLevel,
      levelResult.previousLevel,
    );

    if (richTierMonth) {
      await richTierService.refreshCacheAfterRecharge(
        userId,
        richTierMonth.year,
        richTierMonth.month,
      );
    }

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
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_TIMEOUT_MS },
    );

    await walletService.adjustCoinBalanceCache(userId, USERNAME_CHANGE_COIN_COST);
  },

  /**
   * Debits coins for a paid creator subscription (purchase or renewal).
   * Pass `tx` to participate in a caller-owned serializable transaction; then the caller must
   * `walletService.adjustCoinBalanceCache(userId, amount)` after commit.
   */
  async debitForCreatorSubscription(
    userId: string,
    amount: bigint,
    options: {
      creatorId: string
      subscriptionId: string
      idempotencyKey: string
      description?: string
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (inner: Prisma.TransactionClient) => {
      const wallet = await inner.wallet.upsert({
        where: {
          userId_currencyType: {
            userId,
            currencyType: WalletCurrencyType.COIN,
          },
        },
        create: { userId, currencyType: WalletCurrencyType.COIN },
        update: {},
      });
      await walletRepository.lockForUpdate(inner, wallet.id);
      const last = await inner.coinLedgerEntry.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: "desc" },
        select: { balanceAfter: true },
      });
      const balance = last?.balanceAfter ?? 0n;
      if (balance < amount) {
        throw new AppError(
          402,
          "Insufficient coins",
          "INSUFFICIENT_COINS",
          {
            required: amount.toString(),
            balance: balance.toString(),
          },
        );
      }
      await coinLedgerRepository.insert(inner, {
        walletId: wallet.id,
        direction: LedgerDirection.DEBIT,
        txType: "CREATOR_SUBSCRIPTION" as CoinTxType,
        amount,
        balanceAfter: balance - amount,
        counterpartyId: options.creatorId,
        description: options.description ?? "Creator subscription",
        metadata: {
          creatorId: options.creatorId,
          subscriptionId: options.subscriptionId,
        },
        idempotencyKey: options.idempotencyKey,
      });
      await walletRepository.bumpVersion(inner, wallet.id);
    };

    if (tx) {
      await run(tx);
      return;
    }
    await prisma.$transaction(
      async (inner) => {
        await run(inner);
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_TIMEOUT_MS },
    );
    await walletService.adjustCoinBalanceCache(userId, amount);
  },

  /**
   * Debits coins for a guardian badge purchase. Caller should run inside a Serializable
   * transaction with the guardian upsert; post-commit call `walletService.adjustCoinBalanceCache`.
   */
  async debitForGuardianPurchase(
    userId: string,
    amount: bigint,
    options: {
      targetUserId: string
      idempotencyKey: string
      description?: string
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (inner: Prisma.TransactionClient) => {
      const wallet = await inner.wallet.upsert({
        where: {
          userId_currencyType: {
            userId,
            currencyType: WalletCurrencyType.COIN,
          },
        },
        create: { userId, currencyType: WalletCurrencyType.COIN },
        update: {},
      })
      await walletRepository.lockForUpdate(inner, wallet.id)
      const last = await inner.coinLedgerEntry.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: "desc" },
        select: { balanceAfter: true },
      })
      const balance = last?.balanceAfter ?? 0n
      if (balance < amount) {
        throw new AppError(
          402,
          "Insufficient coins",
          "INSUFFICIENT_COINS",
          {
            required: amount.toString(),
            balance: balance.toString(),
          },
        )
      }
      await coinLedgerRepository.insert(inner, {
        walletId: wallet.id,
        direction: LedgerDirection.DEBIT,
        txType: "GUARDIAN_PURCHASE" as CoinTxType,
        amount,
        balanceAfter: balance - amount,
        counterpartyId: options.targetUserId,
        description: options.description ?? "Guardian purchase",
        metadata: { targetUserId: options.targetUserId },
        idempotencyKey: options.idempotencyKey,
      })
      await walletRepository.bumpVersion(inner, wallet.id)
    }

    if (tx) {
      await run(tx)
      return
    }
    await prisma.$transaction(
      async (inner) => {
        await run(inner)
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_TIMEOUT_MS },
    )
    await walletService.adjustCoinBalanceCache(userId, amount)
  },

  async debitForStoreItemPurchase(
    userId: string,
    amount: bigint,
    options: {
      recipientId: string
      storeItemId: string
      idempotencyKey: string
      description?: string
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (inner: Prisma.TransactionClient) => {
      const wallet = await inner.wallet.upsert({
        where: {
          userId_currencyType: {
            userId,
            currencyType: WalletCurrencyType.COIN,
          },
        },
        create: { userId, currencyType: WalletCurrencyType.COIN },
        update: {},
      })
      await walletRepository.lockForUpdate(inner, wallet.id)
      const last = await inner.coinLedgerEntry.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        select: { balanceAfter: true },
      })
      const balance = last?.balanceAfter ?? 0n
      if (balance < amount) {
        throw new AppError(402, 'Insufficient coins', 'INSUFFICIENT_COINS', {
          required: amount.toString(),
          balance: balance.toString(),
        })
      }
      await coinLedgerRepository.insert(inner, {
        walletId: wallet.id,
        direction: LedgerDirection.DEBIT,
        txType: 'STORE_ITEM_PURCHASE' as CoinTxType,
        amount,
        balanceAfter: balance - amount,
        counterpartyId: options.recipientId,
        description: options.description ?? 'Store item purchase',
        metadata: {
          recipientId: options.recipientId,
          storeItemId: options.storeItemId,
        },
        idempotencyKey: options.idempotencyKey,
      })
      await walletRepository.bumpVersion(inner, wallet.id)
    }
    if (tx) return run(tx)
    await prisma.$transaction(
      async (inner) => run(inner),
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_TIMEOUT_MS },
    )
    await walletService.adjustCoinBalanceCache(userId, amount)
  },

  async debitForVipPurchase(
    userId: string,
    amount: bigint,
    options: {
      recipientId: string
      publicId: string
      idempotencyKey: string
      description?: string
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (inner: Prisma.TransactionClient) => {
      const wallet = await inner.wallet.upsert({
        where: {
          userId_currencyType: {
            userId,
            currencyType: WalletCurrencyType.COIN,
          },
        },
        create: { userId, currencyType: WalletCurrencyType.COIN },
        update: {},
      })
      await walletRepository.lockForUpdate(inner, wallet.id)
      const last = await inner.coinLedgerEntry.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        select: { balanceAfter: true },
      })
      const balance = last?.balanceAfter ?? 0n
      if (balance < amount) {
        throw new AppError(402, 'Insufficient coins', 'INSUFFICIENT_COINS', {
          required: amount.toString(),
          balance: balance.toString(),
        })
      }
      await coinLedgerRepository.insert(inner, {
        walletId: wallet.id,
        direction: LedgerDirection.DEBIT,
        txType: CoinTxType.VIP_PURCHASE,
        amount,
        balanceAfter: balance - amount,
        counterpartyId: options.recipientId,
        description: options.description ?? 'Rare ID purchase',
        metadata: {
          recipientId: options.recipientId,
          publicId: options.publicId,
        },
        idempotencyKey: options.idempotencyKey,
      })
      await walletRepository.bumpVersion(inner, wallet.id)
    }
    if (tx) return run(tx)
    await prisma.$transaction(
      async (inner) => run(inner),
      { isolationLevel: 'Serializable', timeout: INTERACTIVE_TX_TIMEOUT_MS },
    )
    await walletService.adjustCoinBalanceCache(userId, amount)
  },

  /**
   * Generic coin debit inside a caller-owned Serializable transaction.
   * Idempotent on `idempotencyKey` (returns existing ledger row without debiting again).
   */
  async debit(
    userId: string,
    amount: bigint,
    txType: CoinTxType,
    tx: Prisma.TransactionClient,
    options: {
      idempotencyKey: string;
      description?: string;
      metadata?: Prisma.JsonValue;
      counterpartyId?: string;
    },
  ): Promise<{ ledgerEntryId: string; balanceAfter: bigint }> {
    const existing = await coinLedgerRepository.findByIdempotencyKey(
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
          currencyType: WalletCurrencyType.COIN,
        },
      },
      create: { userId, currencyType: WalletCurrencyType.COIN },
      update: {},
    });
    await walletRepository.lockForUpdate(tx, wallet.id);
    const last = await tx.coinLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    });
    const balance = last?.balanceAfter ?? 0n;
    if (balance < amount) {
      throw new AppError(402, "Insufficient coins", "INSUFFICIENT_COINS", {
        required: amount.toString(),
        balance: balance.toString(),
      });
    }

    const entry = await coinLedgerRepository.insert(tx, {
      walletId: wallet.id,
      direction: LedgerDirection.DEBIT,
      txType,
      amount,
      balanceAfter: balance - amount,
      counterpartyId: options.counterpartyId,
      description: options.description,
      metadata: options.metadata as object | undefined,
      idempotencyKey: options.idempotencyKey,
    });
    await walletRepository.bumpVersion(tx, wallet.id);
    return { ledgerEntryId: entry.id, balanceAfter: entry.balanceAfter };
  },

  /**
   * Generic coin credit inside a caller-owned Serializable transaction.
   * When `applyWealthCredit` is true, runs `walletLevelService.applyCredit` for wealth XP.
   * Idempotent on `idempotencyKey`.
   */
  async credit(
    userId: string,
    amount: bigint,
    txType: CoinTxType,
    tx: Prisma.TransactionClient,
    options: {
      idempotencyKey: string;
      description?: string;
      metadata?: Prisma.JsonValue;
      counterpartyId?: string;
      applyWealthCredit: boolean;
    },
  ): Promise<{
    ledgerEntryId: string;
    balanceAfter: bigint;
    levelResult: Awaited<
      ReturnType<typeof walletLevelService.applyCredit>
    > | null;
  }> {
    const existing = await coinLedgerRepository.findByIdempotencyKey(
      tx,
      options.idempotencyKey,
    );
    if (existing) {
      return {
        ledgerEntryId: existing.id,
        balanceAfter: existing.balanceAfter,
        levelResult: null,
      };
    }

    const wallet = await tx.wallet.upsert({
      where: {
        userId_currencyType: {
          userId,
          currencyType: WalletCurrencyType.COIN,
        },
      },
      create: { userId, currencyType: WalletCurrencyType.COIN },
      update: {},
    });
    await walletRepository.lockForUpdate(tx, wallet.id);
    const last = await tx.coinLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    });
    const balance = last?.balanceAfter ?? 0n;
    const newBalance = balance + amount;

    const levelResult = options.applyWealthCredit
      ? await walletLevelService.applyCredit(
          tx,
          userId,
          LevelType.WEALTH,
          amount,
        )
      : null;

    const entry = await coinLedgerRepository.insert(tx, {
      walletId: wallet.id,
      direction: LedgerDirection.CREDIT,
      txType,
      amount,
      balanceAfter: newBalance,
      counterpartyId: options.counterpartyId,
      description: options.description,
      metadata: options.metadata as object | undefined,
      idempotencyKey: options.idempotencyKey,
    });
    await walletRepository.bumpVersion(tx, wallet.id);
    return {
      ledgerEntryId: entry.id,
      balanceAfter: entry.balanceAfter,
      levelResult,
    };
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
