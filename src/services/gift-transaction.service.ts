import crypto, { randomUUID } from "crypto";
import { prisma } from "../config/database";
import { hostGiftPointsFromCoinSpend } from "../config/host-revenue-shares";
import { redisClient, RedisKeys } from "../config/redis";
import { AppError } from "../middlewares/errorHandler";
import { giftRepository } from "../repositories/gift.repository";
import { giftTransactionRepository } from "../repositories/gift-transaction.repository";
import { walletRepository } from "../repositories/wallet.repository";
import { coinLedgerRepository } from "../repositories/coin-ledger.repository";
import { pointLedgerRepository } from "../repositories/point-ledger.repository";
import { walletService } from "./wallet.service";
import { walletLevelService } from "./user-level.service";
import { giftGalleryService } from "./gift-gallery.service";
import {
  WalletCurrencyType,
  CoinTxType,
  PointTxType,
  LedgerDirection,
  LevelType,
} from "@prisma/client";
import { getPeriodKeys } from "../utils/periodKeys";
import { vipMembershipService } from "./vip-membership.service";
import { fanSpendIncrementForGift } from "./vip-membership.helpers";
import { utcDayFromTimestamp } from "../utils/datetime";

const INTERACTIVE_TX_TIMEOUT_MS = 20_000;

async function invalidateAfterGiftSend(params: {
  senderId: string;
  receiverId: string;
  year: number;
  month: number;
  dayKey: string;
  weekKey: string;
  monthKey: string;
}) {
  try {
    await redisClient.del(RedisKeys.walletCoinBalance(params.senderId));
    await redisClient.del(RedisKeys.walletPointBalance(params.receiverId));
    await redisClient.del(
      RedisKeys.fanRanking(params.receiverId, "day", params.dayKey),
    );
    await redisClient.del(
      RedisKeys.fanRanking(params.receiverId, "week", params.weekKey),
    );
    await redisClient.del(
      RedisKeys.fanRanking(params.receiverId, "month", params.monthKey),
    );
  } catch {
    // best-effort
  }
}

export const giftTransactionService = {
  async sendGift(params: {
    senderUserId: string;
    receiverUserId: string;
    giftId: string;
    context: "direct" | "livestream";
  }) {
    if (params.senderUserId === params.receiverUserId) {
      throw new AppError(400, "Cannot send a gift to yourself", "INVALID_REQUEST");
    }

    const gift = await giftRepository.findById(params.giftId);
    if (!gift || !gift.isActive) {
      throw new AppError(404, "Gift not found", "NOT_FOUND");
    }

    const coinCost = gift.coinCost;
    const pointsAwarded = hostGiftPointsFromCoinSpend(coinCost);
    const idemBase = `gift:${crypto.randomUUID()}`;
    const { dayKey, weekKey, monthKey, year, month } = getPeriodKeys();

    const senderHasActiveVipMembership = await vipMembershipService.hasActive(
      params.senderUserId,
    );

    type WealthRet = Awaited<ReturnType<typeof walletLevelService.applyCredit>>;

    const txResult = await prisma.$transaction(
      async (tx) => {
        const senderCoinWallet = await walletRepository.getOrCreate(
          params.senderUserId,
          WalletCurrencyType.COIN,
        );
        const receiverPointWallet = await walletRepository.getOrCreate(
          params.receiverUserId,
          WalletCurrencyType.POINT,
        );

        const ordered = [senderCoinWallet, receiverPointWallet].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        for (const w of ordered) {
          await walletRepository.lockForUpdate(tx, w.id);
        }

        const lastCoin = await tx.coinLedgerEntry.findFirst({
          where: { walletId: senderCoinWallet.id },
          orderBy: { createdAt: "desc" },
          select: { balanceAfter: true },
        });
        const coinBal = lastCoin?.balanceAfter ?? 0n;
        const cost = BigInt(coinCost);
        if (coinBal < cost) {
          throw new AppError(
            402,
            "Insufficient coins",
            "INSUFFICIENT_COINS",
            {
              required: cost.toString(),
              balance: coinBal.toString(),
            },
          );
        }

        await coinLedgerRepository.insert(tx, {
          walletId: senderCoinWallet.id,
          direction: LedgerDirection.DEBIT,
          txType: CoinTxType.GIFT_SEND,
          amount: cost,
          balanceAfter: coinBal - cost,
          counterpartyId: params.receiverUserId,
          description: `Gift: ${gift.name}`,
          metadata: { giftId: params.giftId, context: params.context },
          idempotencyKey: `${idemBase}-coin`,
        });
        await walletRepository.bumpVersion(tx, senderCoinWallet.id);

        let wealthResult: WealthRet | null = null;
        let bustAgentUserId: string | null = null;
        const giftTxRefId = pointsAwarded > 0 ? randomUUID() : null;

        if (pointsAwarded > 0 && giftTxRefId) {
          const pt = BigInt(pointsAwarded);
          const lastPt = await tx.pointLedgerEntry.findFirst({
            where: { walletId: receiverPointWallet.id },
            orderBy: { createdAt: "desc" },
            select: { balanceAfter: true },
          });
          const ptBal = lastPt?.balanceAfter ?? 0n;

          wealthResult = await walletLevelService.applyCredit(
            tx,
            params.receiverUserId,
            LevelType.WEALTH,
            pt,
          );

          const ptEntry = await pointLedgerRepository.insert(tx, {
            walletId: receiverPointWallet.id,
            direction: LedgerDirection.CREDIT,
            txType: PointTxType.GIFT_RECEIVE,
            amount: pt,
            balanceAfter: ptBal + pt,
            refId: giftTxRefId,
            counterpartyId: params.senderUserId,
            description: `Gift received: ${gift.name}`,
            metadata: { giftId: params.giftId, context: params.context },
            idempotencyKey: `${idemBase}-point`,
          });
          await walletRepository.bumpVersion(tx, receiverPointWallet.id);

          const { agencyCommissionService } = await import(
            "./agencyCommission.service"
          );
          const ac = await agencyCommissionService.applyCommission(
            {
              hostUserId: params.receiverUserId,
              hostLedgerEntryId: ptEntry.id,
              hostPointsCredited: pt,
              hostTxType: PointTxType.GIFT_RECEIVE,
              day: utcDayFromTimestamp(new Date()),
            },
            tx,
          );
          bustAgentUserId = ac.bustAgentUserId;
        }

        const gt = await giftTransactionRepository.create(tx, {
          id: giftTxRefId ?? undefined,
          senderUserId: params.senderUserId,
          receiverUserId: params.receiverUserId,
          giftId: params.giftId,
          coinCost,
          pointsAwarded,
          context: params.context,
        });

        const coinIncrement = fanSpendIncrementForGift(
          BigInt(coinCost),
          senderHasActiveVipMembership,
        );
        for (const periodType of ["day", "week", "month"] as const) {
          const key =
            periodType === "day"
              ? dayKey
              : periodType === "week"
                ? weekKey
                : monthKey;
          await tx.fanSpend.upsert({
            where: {
              senderUserId_receiverUserId_periodType_periodKey: {
                senderUserId: params.senderUserId,
                receiverUserId: params.receiverUserId,
                periodType,
                periodKey: key,
              },
            },
            create: {
              senderUserId: params.senderUserId,
              receiverUserId: params.receiverUserId,
              periodType,
              periodKey: key,
              coinsSpent: coinIncrement,
            },
            update: {
              coinsSpent: { increment: coinIncrement },
            },
          });
        }

        return {
          transactionId: gt.id,
          wealthResult,
          bustAgentUserId,
        };
      },
      { isolationLevel: "Serializable", timeout: INTERACTIVE_TX_TIMEOUT_MS },
    );

    await walletService.adjustCoinBalanceCache(params.senderUserId, 0n);
    await walletService.adjustPointBalanceCache(params.receiverUserId, 0n);

    if (txResult.wealthResult && pointsAwarded > 0) {
      await walletLevelService.refreshCache(
        params.receiverUserId,
        LevelType.WEALTH,
        txResult.wealthResult.newCumulative,
        txResult.wealthResult.newLevel,
        txResult.wealthResult.previousLevel,
      );
    }

    if (txResult.bustAgentUserId) {
      const { agencyCommissionService } = await import(
        "./agencyCommission.service"
      );
      await agencyCommissionService.bustAgentCommissionCaches(
        txResult.bustAgentUserId,
      );
    }

    await invalidateAfterGiftSend({
      senderId: params.senderUserId,
      receiverId: params.receiverUserId,
      year,
      month,
      dayKey,
      weekKey,
      monthKey,
    });

    let galleryUpdated = false;
    let galleryNowFull = false;
    try {
      const r = await giftGalleryService.recordGiftProgress({
        hostUserId: params.receiverUserId,
        giftId: params.giftId,
        senderId: params.senderUserId,
      });
      galleryUpdated = r.created;
      galleryNowFull = r.galleryNowFull;
    } catch (err) {
      console.error("[Gift send] recordGiftProgress failed", err);
    }

    const senderCoinsRemaining = await walletService.getCoinBalance(
      params.senderUserId,
    );

    return {
      transactionId: txResult.transactionId,
      giftName: gift.name,
      coinCost,
      pointsAwarded,
      senderCoinsRemaining: Number(senderCoinsRemaining),
      galleryUpdated,
      galleryNowFull,
    };
  },
};
