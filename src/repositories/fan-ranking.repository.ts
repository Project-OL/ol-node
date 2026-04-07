import { prismaRead } from "../config/database";

export type FanSpendTotalsRow = {
  senderUserId: string;
  totalCoins: bigint;
};

export const fanRankingRepository = {
  async topSendersBySpend(params: {
    receiverUserId: string;
    periodType: string;
    periodKey: string;
    limit: number;
  }): Promise<FanSpendTotalsRow[]> {
    const grouped = await prismaRead.fanSpend.groupBy({
      by: ["senderUserId"],
      where: {
        receiverUserId: params.receiverUserId,
        periodType: params.periodType,
        periodKey: params.periodKey,
      },
      _sum: { coinsSpent: true },
      orderBy: { _sum: { coinsSpent: "desc" } },
      take: params.limit,
    });

    return grouped.map((g) => ({
      senderUserId: g.senderUserId,
      totalCoins: g._sum.coinsSpent ?? 0n,
    }));
  },

  async senderSpendForPeriod(params: {
    senderUserId: string;
    receiverUserId: string;
    periodType: string;
    periodKey: string;
  }): Promise<bigint> {
    const row = await prismaRead.fanSpend.findUnique({
      where: {
        senderUserId_receiverUserId_periodType_periodKey: {
          senderUserId: params.senderUserId,
          receiverUserId: params.receiverUserId,
          periodType: params.periodType,
          periodKey: params.periodKey,
        },
      },
      select: { coinsSpent: true },
    });
    return row?.coinsSpent ?? 0n;
  },

  /** 1 + count of other senders with strictly higher total spend in this period. */
  async rankOfSender(params: {
    senderUserId: string;
    receiverUserId: string;
    periodType: string;
    periodKey: string;
    myTotal: bigint;
  }): Promise<number | null> {
    if (params.myTotal === 0n) return null;

    const higher = await prismaRead.$queryRaw<[{ c: bigint }]>`
      SELECT COUNT(*)::bigint AS c
      FROM (
        SELECT sender_user_id
        FROM fan_spend
        WHERE receiver_user_id = ${params.receiverUserId}::uuid
          AND period_type = ${params.periodType}
          AND period_key = ${params.periodKey}
        GROUP BY sender_user_id
        HAVING SUM(coins_spent) > ${params.myTotal}
      ) sub
    `;
    const n = higher[0]?.c ?? 0n;
    return Number(n) + 1;
  },

  async usersPublicFields(userIds: string[]) {
    if (userIds.length === 0) return [];
    return prismaRead.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        walletUserLevels: {
          where: { levelType: "WEALTH" },
          select: { currentLevel: true },
          take: 1,
        },
      },
    });
  },
};

function displayName(u: {
  firstName: string | null;
  lastName: string | null;
  username: string;
}): string {
  const parts = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return parts || u.username;
}

export function mapUserToRankingFields(
  u: Awaited<
    ReturnType<typeof fanRankingRepository.usersPublicFields>
  >[number],
) {
  return {
    userId: u.id,
    username: u.username,
    displayName: displayName(u),
    avatarUrl: u.avatarUrl,
    wealthLevel: u.walletUserLevels[0]?.currentLevel ?? 1,
  };
}
