import {
  CoinTxType,
  LedgerAccountRoleType,
  PointTxType,
  Prisma,
} from '@prisma/client'
import { prismaRead } from '../config/database'
import { formatUserName } from '../utils/user-display'
import { ledgerAccountRoleService } from './ledgerAccountRole.service'
import {
  computeFloatAt,
  masterLedgerService,
  resolveLedgerPeriod,
} from './masterLedger.service'

const WALLET_GAP_LIMIT = 50
const RECENT_ENTRIES_LIMIT = 10
const SUSPECT_USER_LIMIT = 20
const SAMPLE_TX_LIMIT = 5

type WalletGapRow = {
  wallet_id: string
  user_id: string
  currency_type: string
  balance: bigint
  ledger_net: bigint
  gap: bigint
}

type UserCard = {
  userId: string
  publicId: string
  username: string
  name: string
  isAgent: boolean
  houseRole: LedgerAccountRoleType | null
}

function fallbackUserCard(userId: string): UserCard {
  return {
    userId,
    publicId: '',
    username: '',
    name: 'Unknown',
    isAgent: false,
    houseRole: null,
  }
}

async function loadUserCards(userIds: string[]): Promise<Map<string, UserCard>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Map()

  const [users, roles] = await Promise.all([
    prismaRead.user.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        publicId: true,
        username: true,
        firstName: true,
        lastName: true,
        isAgent: true,
      },
    }),
    prismaRead.ledgerAccountRole.findMany({
      where: { userId: { in: unique }, isActive: true },
      select: { userId: true, role: true },
    }),
  ])

  const roleByUser = new Map(roles.map((r) => [r.userId, r.role]))
  return new Map(
    users.map((u) => [
      u.id,
      {
        userId: u.id,
        publicId: u.publicId.toString(),
        username: u.username,
        name: formatUserName(u),
        isAgent: u.isAgent,
        houseRole: roleByUser.get(u.id) ?? null,
      },
    ]),
  )
}

async function loadWalletGaps(at: Date): Promise<WalletGapRow[]> {
  const coinGaps = await prismaRead.$queryRaw<WalletGapRow[]>(Prisma.sql`
    WITH balances AS (
      SELECT w.id AS wallet_id,
             w.user_id::text AS user_id,
             w.currency_type::text AS currency_type,
             COALESCE(
               (SELECT e.balance_after
                FROM coin_ledger_entries e
                WHERE e.wallet_id = w.id AND e.created_at < ${at}
                ORDER BY e.created_at DESC, e.id DESC
                LIMIT 1),
               0
             ) AS balance
      FROM wallets w
      WHERE w.currency_type IN ('COIN', 'TRADING_COIN')
    ),
    nets AS (
      SELECT e.wallet_id,
             COALESCE(
               SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END),
               0
             ) AS ledger_net
      FROM coin_ledger_entries e
      WHERE e.created_at < ${at}
      GROUP BY e.wallet_id
    )
    SELECT b.wallet_id::text AS wallet_id,
           b.user_id,
           b.currency_type,
           b.balance,
           COALESCE(n.ledger_net, 0) AS ledger_net,
           (b.balance - COALESCE(n.ledger_net, 0)) AS gap
    FROM balances b
    LEFT JOIN nets n ON n.wallet_id = b.wallet_id
    WHERE b.balance <> COALESCE(n.ledger_net, 0)
  `)

  const pointGaps = await prismaRead.$queryRaw<WalletGapRow[]>(Prisma.sql`
    WITH balances AS (
      SELECT w.id AS wallet_id,
             w.user_id::text AS user_id,
             w.currency_type::text AS currency_type,
             COALESCE(
               (SELECT e.balance_after
                FROM point_ledger_entries e
                WHERE e.wallet_id = w.id AND e.created_at < ${at}
                ORDER BY e.created_at DESC, e.id DESC
                LIMIT 1),
               0
             ) AS balance
      FROM wallets w
      WHERE w.currency_type = 'POINT'
    ),
    nets AS (
      SELECT e.wallet_id,
             COALESCE(
               SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END),
               0
             ) AS ledger_net
      FROM point_ledger_entries e
      WHERE e.created_at < ${at}
      GROUP BY e.wallet_id
    )
    SELECT b.wallet_id::text AS wallet_id,
           b.user_id,
           b.currency_type,
           b.balance,
           COALESCE(n.ledger_net, 0) AS ledger_net,
           (b.balance - COALESCE(n.ledger_net, 0)) AS gap
    FROM balances b
    LEFT JOIN nets n ON n.wallet_id = b.wallet_id
    WHERE b.balance <> COALESCE(n.ledger_net, 0)
  `)

  return [...coinGaps, ...pointGaps]
}

async function loadRecentCoinEntries(walletId: string, at: Date) {
  return prismaRead.coinLedgerEntry.findMany({
    where: { walletId, createdAt: { lt: at } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: RECENT_ENTRIES_LIMIT,
    select: {
      id: true,
      txType: true,
      direction: true,
      amount: true,
      balanceAfter: true,
      createdAt: true,
      idempotencyKey: true,
    },
  })
}

async function loadRecentPointEntries(walletId: string, at: Date) {
  return prismaRead.pointLedgerEntry.findMany({
    where: { walletId, createdAt: { lt: at } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: RECENT_ENTRIES_LIMIT,
    select: {
      id: true,
      txType: true,
      direction: true,
      amount: true,
      balanceAfter: true,
      createdAt: true,
      idempotencyKey: true,
    },
  })
}

function serializeLedgerEntry(e: {
  id: string
  txType: string
  direction: string
  amount: bigint
  balanceAfter: bigint
  createdAt: Date
  idempotencyKey: string
}) {
  return {
    id: e.id,
    txType: e.txType,
    direction: e.direction,
    amount: e.amount.toString(),
    balanceAfter: e.balanceAfter.toString(),
    createdAt: e.createdAt.toISOString(),
    idempotencyKey: e.idempotencyKey,
  }
}

export const masterLedgerInvestigateService = {
  async investigateBreakage(params: { at?: Date }) {
    const at = params.at ?? new Date()
    const house = await ledgerAccountRoleService.getHouseAccounts()
    const buckets = await computeFloatAt(at, house)

    const allGaps = await loadWalletGaps(at)
    allGaps.sort((a, b) => {
      const absA = a.gap < 0n ? -a.gap : a.gap
      const absB = b.gap < 0n ? -b.gap : b.gap
      if (absA === absB) return 0
      return absA > absB ? -1 : 1
    })

    const truncated = allGaps.length > WALLET_GAP_LIMIT
    const topGaps = allGaps.slice(0, WALLET_GAP_LIMIT)
    const userCards = await loadUserCards(topGaps.map((g) => g.user_id))

    let walletGapSum = 0n
    for (const g of allGaps) walletGapSum += g.gap

    const wallets = await Promise.all(
      topGaps.map(async (g) => {
        const isPoint = g.currency_type === 'POINT'
        const recent = isPoint
          ? await loadRecentPointEntries(g.wallet_id, at)
          : await loadRecentCoinEntries(g.wallet_id, at)
        return {
          walletId: g.wallet_id,
          currency: g.currency_type,
          gap: g.gap.toString(),
          balance: g.balance.toString(),
          ledgerNet: g.ledger_net.toString(),
          user: userCards.get(g.user_id) ?? fallbackUserCard(g.user_id),
          recentEntries: recent.map(serializeLedgerEntry),
        }
      }),
    )

    return {
      at: at.toISOString(),
      identityDelta: buckets.identityDelta.toString(),
      walletGapSum: walletGapSum.toString(),
      truncated,
      walletCount: allGaps.length,
      wallets,
    }
  },

  async investigateReconciliation(params: {
    from?: Date
    to?: Date
    grain?: Parameters<typeof resolveLedgerPeriod>[0]['grain']
  }) {
    const period = resolveLedgerPeriod({
      from: params.from,
      to: params.to,
      grain: params.grain,
    })
    const dashboard = await masterLedgerService.dashboard({
      from: period.from,
      to: period.to,
      grain: period.grain,
    })

    const house = await ledgerAccountRoleService.getHouseAccounts()
    const houseIds = [...house.allIds]
    const houseSql =
      houseIds.length > 0
        ? Prisma.join(houseIds.map((id) => Prisma.sql`${id}::uuid`))
        : null

    const from = period.from
    const to = period.to

    type SenderAgg = { sender_id: string; units: bigint; cnt: bigint }

    const unregisteredTradingSenders: SenderAgg[] =
      houseSql == null
        ? await prismaRead.$queryRaw<SenderAgg[]>(Prisma.sql`
            SELECT t.sender_agent_user_id::text AS sender_id,
                   COALESCE(SUM(t.trading_coins_debited), 0) AS units,
                   COUNT(*)::bigint AS cnt
            FROM coin_trading_transfers t
            WHERE t.reversed_at IS NULL
              AND t.created_at >= ${from}
              AND t.created_at < ${to}
            GROUP BY t.sender_agent_user_id
            ORDER BY units DESC
            LIMIT ${SUSPECT_USER_LIMIT}
          `)
        : await prismaRead.$queryRaw<SenderAgg[]>(Prisma.sql`
            SELECT t.sender_agent_user_id::text AS sender_id,
                   COALESCE(SUM(t.trading_coins_debited), 0) AS units,
                   COUNT(*)::bigint AS cnt
            FROM coin_trading_transfers t
            WHERE t.sender_agent_user_id NOT IN (${houseSql})
              AND t.reversed_at IS NULL
              AND t.created_at >= ${from}
              AND t.created_at < ${to}
            GROUP BY t.sender_agent_user_id
            ORDER BY units DESC
            LIMIT ${SUSPECT_USER_LIMIT}
          `)

    const unregisteredPointSenders: SenderAgg[] =
      houseSql == null
        ? await prismaRead.$queryRaw<SenderAgg[]>(Prisma.sql`
            SELECT t.sender_agent_user_id::text AS sender_id,
                   COALESCE(SUM(t.points), 0) AS units,
                   COUNT(*)::bigint AS cnt
            FROM agent_point_transfers t
            WHERE t.created_at >= ${from}
              AND t.created_at < ${to}
            GROUP BY t.sender_agent_user_id
            ORDER BY units DESC
            LIMIT ${SUSPECT_USER_LIMIT}
          `)
        : await prismaRead.$queryRaw<SenderAgg[]>(Prisma.sql`
            SELECT t.sender_agent_user_id::text AS sender_id,
                   COALESCE(SUM(t.points), 0) AS units,
                   COUNT(*)::bigint AS cnt
            FROM agent_point_transfers t
            WHERE t.sender_agent_user_id NOT IN (${houseSql})
              AND t.created_at >= ${from}
              AND t.created_at < ${to}
            GROUP BY t.sender_agent_user_id
            ORDER BY units DESC
            LIMIT ${SUSPECT_USER_LIMIT}
          `)

    const returnsToHouse =
      houseSql == null
        ? []
        : await prismaRead.$queryRaw<
            { flow_kind: string; sender_id: string; units: bigint; cnt: bigint }[]
          >(Prisma.sql`
            SELECT 'COIN_TRADING_TRANSFER'::text AS flow_kind,
                   t.sender_agent_user_id::text AS sender_id,
                   COALESCE(SUM(t.trading_coins_debited), 0) AS units,
                   COUNT(*)::bigint AS cnt
            FROM coin_trading_transfers t
            WHERE t.recipient_user_id IN (${houseSql})
              AND t.sender_agent_user_id NOT IN (${houseSql})
              AND t.reversed_at IS NULL
              AND t.created_at >= ${from}
              AND t.created_at < ${to}
            GROUP BY t.sender_agent_user_id
            UNION ALL
            SELECT 'AGENT_POINT_TRANSFER'::text AS flow_kind,
                   t.sender_agent_user_id::text AS sender_id,
                   COALESCE(SUM(t.points), 0) AS units,
                   COUNT(*)::bigint AS cnt
            FROM agent_point_transfers t
            WHERE t.recipient_agent_user_id IN (${houseSql})
              AND t.sender_agent_user_id NOT IN (${houseSql})
              AND t.created_at >= ${from}
              AND t.created_at < ${to}
            GROUP BY t.sender_agent_user_id
            ORDER BY units DESC
            LIMIT ${SUSPECT_USER_LIMIT}
          `)

    type AdjustAgg = { user_id: string; units: bigint; cnt: bigint }

    const largeAdjustments: AdjustAgg[] = await prismaRead.$queryRaw<AdjustAgg[]>(Prisma.sql`
      SELECT a.user_id,
             COALESCE(SUM(a.amount), 0) AS units,
             COUNT(*)::bigint AS cnt
      FROM (
        SELECT w.user_id::text AS user_id, e.amount
        FROM coin_ledger_entries e
        JOIN wallets w ON w.id = e.wallet_id
        WHERE e.tx_type = 'ADJUSTMENT'
          AND e.created_at >= ${from}
          AND e.created_at < ${to}
          ${houseSql ? Prisma.sql`AND w.user_id NOT IN (${houseSql})` : Prisma.empty}
        UNION ALL
        SELECT w.user_id::text AS user_id, e.amount
        FROM point_ledger_entries e
        JOIN wallets w ON w.id = e.wallet_id
        WHERE e.tx_type = 'ADJUSTMENT'
          AND e.created_at >= ${from}
          AND e.created_at < ${to}
          ${houseSql ? Prisma.sql`AND w.user_id NOT IN (${houseSql})` : Prisma.empty}
      ) a
      GROUP BY a.user_id
      ORDER BY units DESC
      LIMIT ${SUSPECT_USER_LIMIT}
    `)

    const suspectUserIds = [
      ...unregisteredTradingSenders.map((r) => r.sender_id),
      ...unregisteredPointSenders.map((r) => r.sender_id),
      ...returnsToHouse.map((r) => r.sender_id),
      ...largeAdjustments.map((r) => r.user_id),
    ]
    const userCards = await loadUserCards(suspectUserIds)

    async function sampleTradingTransfers(senderId: string) {
      return prismaRead.coinTradingTransfer.findMany({
        where: {
          senderAgentUserId: senderId,
          reversedAt: null,
          createdAt: { gte: from, lt: to },
        },
        orderBy: { createdAt: 'desc' },
        take: SAMPLE_TX_LIMIT,
        select: { id: true, recipientUserId: true, tradingCoinsDebited: true, createdAt: true },
      })
    }

    async function samplePointTransfers(senderId: string) {
      return prismaRead.agentPointTransfer.findMany({
        where: {
          senderAgentUserId: senderId,
          createdAt: { gte: from, lt: to },
        },
        orderBy: { createdAt: 'desc' },
        take: SAMPLE_TX_LIMIT,
        select: { id: true, recipientAgentUserId: true, points: true, createdAt: true },
      })
    }

    async function sampleAdjustments(userId: string) {
      const [coins, points] = await Promise.all([
        prismaRead.coinLedgerEntry.findMany({
          where: {
            txType: CoinTxType.ADJUSTMENT,
            createdAt: { gte: from, lt: to },
            wallet: { userId },
          },
          orderBy: { createdAt: 'desc' },
          take: SAMPLE_TX_LIMIT,
          select: {
            id: true,
            direction: true,
            amount: true,
            createdAt: true,
            wallet: { select: { currencyType: true } },
          },
        }),
        prismaRead.pointLedgerEntry.findMany({
          where: {
            txType: PointTxType.ADJUSTMENT,
            createdAt: { gte: from, lt: to },
            wallet: { userId },
          },
          orderBy: { createdAt: 'desc' },
          take: SAMPLE_TX_LIMIT,
          select: { id: true, direction: true, amount: true, createdAt: true },
        }),
      ])
      return [
        ...coins.map((e) => ({
          id: e.id,
          kind: 'COIN' as const,
          currency: e.wallet.currencyType,
          direction: e.direction,
          amount: e.amount.toString(),
          createdAt: e.createdAt.toISOString(),
        })),
        ...points.map((e) => ({
          id: e.id,
          kind: 'POINT' as const,
          currency: 'POINT' as const,
          direction: e.direction,
          amount: e.amount.toString(),
          createdAt: e.createdAt.toISOString(),
        })),
      ]
    }

    const unregisteredTreasurySenders = await Promise.all(
      unregisteredTradingSenders.map(async (row) => ({
        kind: 'UNREGISTERED_TRADING_SENDER' as const,
        units: row.units.toString(),
        transferCount: Number(row.cnt),
        hint: 'Register this agent as TREASURY if they sell platform inventory.',
        user: userCards.get(row.sender_id) ?? fallbackUserCard(row.sender_id),
        samples: (await sampleTradingTransfers(row.sender_id)).map((t) => ({
          id: t.id,
          recipientUserId: t.recipientUserId,
          units: t.tradingCoinsDebited.toString(),
          createdAt: t.createdAt.toISOString(),
        })),
      })),
    )

    const unregisteredPointSendersOut = await Promise.all(
      unregisteredPointSenders.map(async (row) => ({
        kind: 'UNREGISTERED_POINT_SENDER' as const,
        units: row.units.toString(),
        transferCount: Number(row.cnt),
        hint: 'Register this agent as TREASURY if they sell platform inventory.',
        user: userCards.get(row.sender_id) ?? fallbackUserCard(row.sender_id),
        samples: (await samplePointTransfers(row.sender_id)).map((t) => ({
          id: t.id,
          recipientUserId: t.recipientAgentUserId,
          units: t.points.toString(),
          createdAt: t.createdAt.toISOString(),
        })),
      })),
    )

    const returnsToHouseOut = await Promise.all(
      returnsToHouse.map(async (row) => ({
        kind: 'RETURN_TO_HOUSE' as const,
        flowKind: row.flow_kind,
        units: row.units.toString(),
        transferCount: Number(row.cnt),
        hint: 'Customer or agent sent units back to a registered house account.',
        user: userCards.get(row.sender_id) ?? fallbackUserCard(row.sender_id),
        samples:
          row.flow_kind === 'COIN_TRADING_TRANSFER'
            ? (await sampleTradingTransfers(row.sender_id)).map((t) => ({
                id: t.id,
                recipientUserId: t.recipientUserId,
                units: t.tradingCoinsDebited.toString(),
                createdAt: t.createdAt.toISOString(),
              }))
            : (await samplePointTransfers(row.sender_id)).map((t) => ({
                id: t.id,
                recipientUserId: t.recipientAgentUserId,
                units: t.points.toString(),
                createdAt: t.createdAt.toISOString(),
              })),
      })),
    )

    const largeAdjustmentsOut = await Promise.all(
      largeAdjustments.map(async (row) => ({
        kind: 'LARGE_CUSTOMER_ADJUSTMENT' as const,
        units: row.units.toString(),
        entryCount: Number(row.cnt),
        hint: 'Non-house admin Adjust activity in this period.',
        user: userCards.get(row.user_id) ?? fallbackUserCard(row.user_id),
        samples: await sampleAdjustments(row.user_id),
      })),
    )

    const rec = dashboard.reconciliation
    return {
      period: dashboard.period,
      reconciliation: rec,
      delta: rec.delta,
      deltaUsd: rec.deltaUsd,
      equation: {
        grossSaleUnits: rec.grossSaleUnits,
        companyPayoutUnits: rec.companyPayoutUnits,
        deltaCustomerFloatUnits: rec.deltaCustomerFloatUnits,
        operatingProfitUnits: rec.operatingProfitUnits,
      },
      note: 'Investigation leads — rows may not sum exactly to the reconciliation delta.',
      suspects: {
        unregisteredTreasurySenders,
        unregisteredPointSenders: unregisteredPointSendersOut,
        returnsToHouse: returnsToHouseOut,
        largeCustomerAdjustments: largeAdjustmentsOut,
      },
    }
  },
}
