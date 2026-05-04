import { randomUUID } from "crypto";
import { PointTxType, Prisma } from "@prisma/client";
import { prisma, prismaRead } from "../config/database";
import {
  getRedisForRead,
  redisClient,
  RedisKeys,
  AGENCY_COMMISSION_ME_CACHE_TTL,
  AGENCY_LEVEL_CONFIG_CACHE_TTL,
  AGENCY_RATE_CACHE_TTL,
} from "../config/redis";
import { agencyCommissionRepository } from "../repositories/agencyCommission.repository";
import { agencyPointTransferRepository } from "../repositories/agencyPointTransfer.repository";
import { pointWalletService } from "./point-wallet.service";
import { cacheRedisService } from "./cacheRedis.service";
import { AppError } from "../middlewares/errorHandler";
import {
  addUtcDays,
  agencyCommissionRollingWindowDays,
  utcDateString,
  utcNow,
  utcRollingPeriodDays,
  utcStartOfDay,
} from "../utils/datetime";
import { enqueueAgencyRecomputeMaster as publishAgencyRecomputeMasterJob } from "../queues/agency-commission.queue";
import { walletService } from "./wallet.service";

const INTERACTIVE_TX_TIMEOUT_MS = 20_000;
export const MIN_AGENT_POINT_TRANSFER = 100_000n;

export const LIVE_COMMISSION_TX_TYPES = new Set<PointTxType>([
  PointTxType.LIVESTREAM_GIFT,
  PointTxType.GIFT_RECEIVE,
]);

export const MATCH_CHAT_COMMISSION_TX_TYPES = new Set<PointTxType>([
  PointTxType.VIDEO_CALL,
  PointTxType.SUBSCRIPTION,
]);

export const COMMISSION_ELIGIBLE_TX_TYPES = new Set<PointTxType>([
  ...LIVE_COMMISSION_TX_TYPES,
  ...MATCH_CHAT_COMMISSION_TX_TYPES,
]);

export type CommissionCategory = "LIVE" | "MATCH_CHAT";

function categoryForTx(txType: PointTxType): CommissionCategory | null {
  if (LIVE_COMMISSION_TX_TYPES.has(txType)) return "LIVE";
  if (MATCH_CHAT_COMMISSION_TX_TYPES.has(txType)) return "MATCH_CHAT";
  return null;
}

export const agencyCommissionService = {
  /**
   * Hot path: host point credit — same Serializable tx as host ledger insert.
   */
  async applyCommission(
    params: {
      hostUserId: string;
      hostLedgerEntryId: string;
      hostPointsCredited: bigint;
      hostTxType: PointTxType;
      day: Date;
    },
    tx: Prisma.TransactionClient,
  ): Promise<{ bustAgentUserId: string | null }> {
    const host = await tx.user.findUnique({
      where: { id: params.hostUserId },
      select: { currentAgencyId: true },
    });
    const agencyUserId = host?.currentAgencyId ?? null;
    if (!agencyUserId) {
      return { bustAgentUserId: null };
    }

    if (!COMMISSION_ELIGIBLE_TX_TYPES.has(params.hostTxType)) {
      return { bustAgentUserId: null };
    }

    const commissionKey = `agency-commission:${params.hostLedgerEntryId}`;

    const agencyRow = await tx.agency.findUnique({
      where: { userId: agencyUserId },
      select: { currentLevel: true },
    });
    const levelKey = agencyRow?.currentLevel ?? "D";
    const levelCfg = await tx.agencyCommissionLevel.findUnique({
      where: { level: levelKey },
    });
    if (!levelCfg) {
      throw new AppError(500, "Missing agency commission level row", "CONFIG_ERROR");
    }

    const cat = categoryForTx(params.hostTxType);
    if (!cat) {
      return { bustAgentUserId: null };
    }
    const rateBp =
      cat === "LIVE" ? levelCfg.liveRateBp : levelCfg.matchChatRateBp;

    const commissionPoints =
      (params.hostPointsCredited * BigInt(rateBp)) / 10_000n;

    try {
      await tx.agencyCommissionProcessed.create({
        data: { hostLedgerEntryId: params.hostLedgerEntryId },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        return { bustAgentUserId: null };
      }
      throw e;
    }

    await agencyCommissionRepository.upsertDailyEarning(
      {
        agencyUserId,
        hostUserId: params.hostUserId,
        day: params.day,
        hostEarningsDelta: params.hostPointsCredited,
        hostCommissionDelta: commissionPoints,
      },
      tx,
    );

    if (commissionPoints > 0n) {
      await pointWalletService.creditInTransaction(
        agencyUserId,
        commissionPoints,
        PointTxType.AGENT_COMMISSION,
        tx,
        {
          idempotencyKey: commissionKey,
          refId: params.hostLedgerEntryId,
          counterpartyId: params.hostUserId,
          metadata: {
            category: cat,
            rateBp,
            hostTxType: params.hostTxType,
          },
          applyLivestreamLevel: false,
        },
      );
    }

    return { bustAgentUserId: agencyUserId };
  },

  async bustAgentCommissionCaches(agencyUserId: string): Promise<void> {
    try {
      await redisClient.del(RedisKeys.agencyRate(agencyUserId));
      await bustAgencyCommissionMeKeys(agencyUserId);
      await cacheRedisService.del(RedisKeys.agencyMe(agencyUserId));
    } catch {
      /* ignore */
    }
  },

  async buildMeAgentCommissionSummary(agentUserId: string) {
    const snap = await this.getCommissionMeSnapshot(agentUserId, 30);
    return {
      currentLevel: snap.currentLevel,
      currentLiveRatePercent: snap.currentLiveRateBp / 100,
      currentMatchChatRatePercent: snap.currentMatchChatRateBp / 100,
      currentWindowTotalPoints: snap.currentWindowTotalPoints,
      nextLevel: snap.nextLevel,
      nextLevelRequirementPoints: snap.lackingPointsToNextLevel,
    };
  },

  async getLevelConfig(): Promise<
    Array<{
      level: string;
      minWindowPoints: string;
      liveRateBp: number;
      matchChatRateBp: number;
      sortOrder: number;
    }>
  > {
    const redis = getRedisForRead();
    const key = RedisKeys.agencyLevelConfig();
    try {
      const hit = await redis.get(key);
      if (hit) {
        return JSON.parse(hit) as Array<{
          level: string;
          minWindowPoints: string;
          liveRateBp: number;
          matchChatRateBp: number;
          sortOrder: number;
        }>;
      }
    } catch {
      /* cold */
    }
    const rows = await agencyCommissionRepository.getLevelConfig();
    const dto = rows.map((r) => ({
      level: r.level,
      minWindowPoints: r.minWindowPoints.toString(),
      liveRateBp: r.liveRateBp,
      matchChatRateBp: r.matchChatRateBp,
      sortOrder: r.sortOrder,
    }));
    try {
      await redisClient.set(
        key,
        JSON.stringify(dto),
        "EX",
        AGENCY_LEVEL_CONFIG_CACHE_TTL,
      );
    } catch {
      /* ignore */
    }
    return dto;
  },

  async getRateForAgent(
    agencyUserId: string,
    category: CommissionCategory,
  ): Promise<{ level: string; rateBp: number }> {
    const redis = getRedisForRead();
    const key = RedisKeys.agencyRate(agencyUserId);
    try {
      const hit = await redis.get(key);
      if (hit) {
        const parsed = JSON.parse(hit) as {
          level: string;
          liveRateBp: number;
          matchChatRateBp: number;
        };
        return {
          level: parsed.level,
          rateBp:
            category === "LIVE" ? parsed.liveRateBp : parsed.matchChatRateBp,
        };
      }
    } catch {
      /* cold */
    }

    const agencyRow = await prismaRead.agency.findUnique({
      where: { userId: agencyUserId },
      select: { currentLevel: true },
    });
    const levelKey = agencyRow?.currentLevel ?? "D";
    const cfg = await agencyCommissionRepository.getLevelRow(levelKey);
    if (!cfg) {
      throw new AppError(500, "Missing agency commission level row", "CONFIG_ERROR");
    }
    const payload = {
      level: cfg.level,
      liveRateBp: cfg.liveRateBp,
      matchChatRateBp: cfg.matchChatRateBp,
    };
    try {
      await redisClient.set(
        key,
        JSON.stringify(payload),
        "EX",
        AGENCY_RATE_CACHE_TTL,
      );
    } catch {
      /* ignore */
    }
    return {
      level: cfg.level,
      rateBp:
        category === "LIVE" ? cfg.liveRateBp : cfg.matchChatRateBp,
    };
  },

  async recomputeAgencyLevel(
    agencyUserId: string,
    opts?: { skipDailyDedupe?: boolean },
  ): Promise<void> {
    const now = utcNow();
    const { fromDay, toDay } = agencyCommissionRollingWindowDays(now);

    if (!opts?.skipDailyDedupe) {
      const cur = await prismaRead.agency.findUnique({
        where: { userId: agencyUserId },
        select: { lastLevelRecomputedAt: true },
      });
      if (
        cur?.lastLevelRecomputedAt &&
        utcDateString(cur.lastLevelRecomputedAt) === utcDateString(now)
      ) {
        return;
      }
    }

    const total = await agencyCommissionRepository.getAgencyWindowTotal(
      agencyUserId,
      fromDay,
      toDay,
    );
    const levels = await agencyCommissionRepository.getLevelConfig();
    let newLevel = "D";
    for (let i = levels.length - 1; i >= 0; i--) {
      const row = levels[i]!;
      if (total >= row.minWindowPoints) {
        newLevel = row.level;
        break;
      }
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.agency.update({
          where: { userId: agencyUserId },
          data: {
            currentLevel: newLevel,
            currentWindowTotalPoints: total,
            lastLevelRecomputedAt: now,
          },
        });
      },
      {
        isolationLevel: "Serializable",
        timeout: INTERACTIVE_TX_TIMEOUT_MS,
      },
    );

    await redisClient.del(RedisKeys.agencyRate(agencyUserId));
    await bustAgencyCommissionMeKeys(agencyUserId);
    await cacheRedisService.del(RedisKeys.agencyMe(agencyUserId));
  },

  async enqueueDailyRecomputeMaster(opts?: {
    utcDate?: string;
    force?: boolean;
  }): Promise<void> {
    const d = opts?.utcDate ?? utcDateString(utcNow());
    await publishAgencyRecomputeMasterJob(d, opts?.force);
  },

  /** Half-open window `[from, toExclusive)` in UTC for ledger timestamps. */
  resolvePeriodBounds(periodDays: number): { from: Date; toExclusive: Date } {
    const dayStart = utcStartOfDay(utcNow());
    const from = addUtcDays(dayStart, -periodDays);
    const toExclusive = addUtcDays(dayStart, 1);
    return { from, toExclusive };
  },

  async getCommissionMeSnapshot(
    agencyUserId: string,
    periodDays: number,
  ): Promise<{
    currentLevel: string;
    currentWindowTotalPoints: string;
    currentLiveRateBp: number;
    currentMatchChatRateBp: number;
    nextLevel: string | null;
    nextLevelMinWindowPoints: string | null;
    lackingPointsToNextLevel: string | null;
    periodDays: number;
    byTxType: Array<{ txType: string; totalAmount: string }>;
  }> {
    const key = RedisKeys.agencyCommissionMe(agencyUserId, periodDays);
    try {
      const hit = await getRedisForRead().get(key);
      if (hit) return JSON.parse(hit) as never;
    } catch {
      /* miss */
    }

    const { from, toExclusive } = this.resolvePeriodBounds(periodDays);
    const ag = await prismaRead.agency.findUnique({
      where: { userId: agencyUserId },
    });
    if (!ag) {
      throw new AppError(404, "Agency not found", "NOT_FOUND");
    }
    const cfg = await agencyCommissionRepository.getLevelRow(ag.currentLevel);
    const levels = await agencyCommissionRepository.getLevelConfig();
    const idx = levels.findIndex((l) => l.level === ag.currentLevel);
    const nextRow = idx >= 0 && idx + 1 < levels.length ? levels[idx + 1]! : null;

    const { fromDay, toDay } = agencyCommissionRollingWindowDays();
    const windowTotal = await agencyCommissionRepository.getAgencyWindowTotal(
      agencyUserId,
      fromDay,
      toDay,
    );

    const agg = await agencyCommissionRepository.aggregateLedgerByTxTypeForAgencyHosts({
      agencyUserId,
      from,
      toExclusive,
    });

    let lacking: bigint | null = null;
    if (nextRow) {
      const gap = nextRow.minWindowPoints - windowTotal;
      lacking = gap > 0n ? gap : 0n;
    }

    const snap = {
      currentLevel: ag.currentLevel,
      currentWindowTotalPoints: windowTotal.toString(),
      currentLiveRateBp: cfg?.liveRateBp ?? 400,
      currentMatchChatRateBp: cfg?.matchChatRateBp ?? 400,
      nextLevel: nextRow?.level ?? null,
      nextLevelMinWindowPoints: nextRow?.minWindowPoints.toString() ?? null,
      lackingPointsToNextLevel: lacking?.toString() ?? null,
      periodDays,
      byTxType: agg.map((r) => ({
        txType: r.txType,
        totalAmount: r.totalAmount.toString(),
      })),
    };

    try {
      await redisClient.set(key, JSON.stringify(snap), "EX", AGENCY_COMMISSION_ME_CACHE_TTL);
    } catch {
      /* ignore */
    }
    return snap;
  },

  async listHostsByEarnings(
    agencyUserId: string,
    periodDays: number,
    opts: { limit: number; offset: number },
  ) {
    const { fromDay, toDay } = utcRollingPeriodDays(periodDays);
    const rows = await agencyCommissionRepository.sumHostEarningsByHost(
      agencyUserId,
      fromDay,
      toDay,
      { limit: opts.limit, offset: opts.offset },
    );
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: page.map((r) => ({
        hostUserId: r.hostUserId,
        hostEarningsPoints: r.hostEarningsPoints.toString(),
        hostCommissionPoints: r.hostCommissionPoints.toString(),
      })),
      nextOffset: hasMore ? opts.offset + opts.limit : null,
    };
  },

  async getHostCommissionDetail(
    agencyUserId: string,
    hostUserId: string,
    periodDays: number,
  ) {
    const membership = await prismaRead.agencyHost.findUnique({
      where: { hostUserId },
      select: { agencyUserId: true },
    });
    if (!membership || membership.agencyUserId !== agencyUserId) {
      throw new AppError(403, "Host not in your agency", "FORBIDDEN");
    }

    const { from, toExclusive } = this.resolvePeriodBounds(periodDays);
    const rows = await agencyCommissionRepository.aggregateLedgerForSingleHost({
      hostUserId,
      agencyUserId,
      from,
      toExclusive,
    });
    const map = Object.fromEntries(rows.map((r) => [r.txType, r.totalAmount])) as Record<
      string,
      bigint
    >;

    let liveEarnings = 0n;
    for (const t of LIVE_COMMISSION_TX_TYPES) {
      liveEarnings += map[t] ?? 0n;
    }
    const privateChat = map.VIDEO_CALL ?? 0n;
    const subscription = map.SUBSCRIPTION ?? 0n;
    const platformRewards = map.PLATFORM_REWARD ?? 0n;

    let other = 0n;
    for (const pt of COMMISSION_ELIGIBLE_TX_TYPES) {
      if (
        !LIVE_COMMISSION_TX_TYPES.has(pt) &&
        !MATCH_CHAT_COMMISSION_TX_TYPES.has(pt)
      ) {
        other += map[pt] ?? 0n;
      }
    }

    return {
      hostUserId,
      periodDays,
      totals: {
        allCredits: Object.values(map).reduce((a, b) => a + b, 0n).toString(),
        liveEarnings: liveEarnings.toString(),
        privateChat: privateChat.toString(),
        subscription: subscription.toString(),
        platformRewards: platformRewards.toString(),
        otherEarnings: other.toString(),
      },
      byTxType: rows.map((r) => ({
        txType: r.txType,
        totalAmount: r.totalAmount.toString(),
      })),
    };
  },

  async transferPointsToAgent(params: {
    senderAgentUserId: string;
    recipientAgentUserId: string;
    points: bigint;
    idempotencyKey: string;
  }): Promise<{ transferId: string }> {
    const {
      senderAgentUserId,
      recipientAgentUserId,
      points,
      idempotencyKey,
    } = params;

    if (senderAgentUserId === recipientAgentUserId) {
      throw new AppError(400, "Cannot transfer to yourself", "INVALID_RECIPIENT");
    }
    if (points < MIN_AGENT_POINT_TRANSFER) {
      throw new AppError(
        400,
        `Minimum transfer is ${MIN_AGENT_POINT_TRANSFER.toString()} points`,
        "MIN_TRANSFER_VIOLATION",
      );
    }

    const [senderAg, recipientAg] = await Promise.all([
      prismaRead.agency.findUnique({
        where: { userId: senderAgentUserId },
      }),
      prismaRead.agency.findUnique({
        where: { userId: recipientAgentUserId },
      }),
    ]);
    if (!senderAg) {
      throw new AppError(403, "Sender is not an agent", "NOT_AN_AGENT");
    }
    if (!recipientAg) {
      throw new AppError(400, "Recipient is not an agent", "INVALID_RECIPIENT");
    }

    const existingBefore = await prismaRead.agentPointTransfer.findUnique({
      where: { idempotencyKey },
    });
    if (existingBefore) {
      return { transferId: existingBefore.id };
    }

    const transferId = randomUUID();

    await prisma.$transaction(
      async (tx) => {
        const existing = await tx.agentPointTransfer.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          return;
        }

        const debit = await pointWalletService.debit(
          senderAgentUserId,
          points,
          PointTxType.AGENT_POINT_TRANSFER,
          tx,
          {
            idempotencyKey: `${idempotencyKey}:debit`,
            counterpartyId: recipientAgentUserId,
            metadata: { transferId },
          },
        );

        const credit = await pointWalletService.creditInTransaction(
          recipientAgentUserId,
          points,
          PointTxType.AGENT_POINT_TRANSFER,
          tx,
          {
            idempotencyKey: `${idempotencyKey}:credit`,
            counterpartyId: senderAgentUserId,
            metadata: { transferId },
            applyLivestreamLevel: false,
          },
        );

        await agencyPointTransferRepository.insertTransfer(
          {
            id: transferId,
            senderAgentUserId,
            recipientAgentUserId,
            points,
            senderLedgerEntryId: debit.ledgerEntryId,
            recipientLedgerEntryId: credit.ledgerEntryId,
            idempotencyKey,
          },
          tx,
        );
      },
      {
        isolationLevel: "Serializable",
        timeout: INTERACTIVE_TX_TIMEOUT_MS,
      },
    );

    await Promise.all([
      walletService.adjustPointBalanceCache(senderAgentUserId, -points),
      walletService.adjustPointBalanceCache(recipientAgentUserId, points),
    ]);

    return { transferId };
  },
};

async function bustAgencyCommissionMeKeys(agencyUserId: string): Promise<void> {
  try {
    const pattern = `agency:commission:me:${agencyUserId}*`;
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) await redisClient.del(...keys);
  } catch {
    /* ignore */
  }
}
