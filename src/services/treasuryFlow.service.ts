import { Prisma, TreasuryFlowClassificationType, TreasuryFlowKind } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { unitsToUsd } from '../utils/points-currency'
import { buildUserDisplayName, formatUserName } from '../utils/user-display'
import { ledgerAccountRoleService, type HouseAccounts } from './ledgerAccountRole.service'

/**
 * Treasury outflows are the imputed sale events of the master ledger.
 *
 * Classification is override-only: the absence of a `treasury_flow_classifications`
 * row means SALE, so switching to this model needs no backfill. House-to-house
 * movement is always INTERNAL and is computed, never stored.
 */

export type TreasuryFlowTotals = {
  saleUnits: bigint
  promoUnits: bigint
  writeOffUnits: bigint
  internalUnits: bigint
  /** Sales booked in an earlier period but reversed inside this one. */
  reversedSaleUnits: bigint
  saleCount: number
}

export const ZERO_TREASURY_TOTALS: TreasuryFlowTotals = {
  saleUnits: 0n,
  promoUnits: 0n,
  writeOffUnits: 0n,
  internalUnits: 0n,
  reversedSaleUnits: 0n,
  saleCount: 0,
}

type AggRow = { kind: string; units: bigint | null; cnt: bigint | null }

type FlowRow = {
  flow_kind: TreasuryFlowKind
  flow_id: string
  sender_user_id: string
  recipient_user_id: string
  units: bigint
  classification: TreasuryFlowClassificationType | null
  kind: TreasuryFlowClassificationType
  reversed_at: Date | null
  created_at: Date
}

const userSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  publicId: true,
  avatarUrl: true,
  isAgent: true,
} satisfies Prisma.UserSelect

/**
 * Effective classification for a flow. A house recipient always wins over any
 * stored override, because moving units between our own accounts can never be
 * revenue no matter what an admin tagged it.
 */
export function effectiveClassification(
  recipientUserId: string,
  stored: TreasuryFlowClassificationType | null,
  house: HouseAccounts,
): TreasuryFlowClassificationType {
  if (house.allIds.has(recipientUserId)) return TreasuryFlowClassificationType.INTERNAL
  return stored ?? TreasuryFlowClassificationType.SALE
}

function idList(house: HouseAccounts): Prisma.Sql {
  return Prisma.join([...house.allIds].map((id) => Prisma.sql`${id}::uuid`))
}

/** SQL for the effective classification, mirroring {@link effectiveClassification}. */
function kindSql(ids: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    CASE WHEN t2.recipient_user_id IN (${ids}) THEN 'INTERNAL'
         ELSE COALESCE(c.classification::text, 'SALE') END`
}

function windowSql(column: Prisma.Sql, from?: Date, to?: Date): Prisma.Sql {
  return Prisma.sql`
    ${from ? Prisma.sql`AND ${column} >= ${from}` : Prisma.empty}
    ${to ? Prisma.sql`AND ${column} < ${to}` : Prisma.empty}`
}

function applyAgg(totals: TreasuryFlowTotals, rows: AggRow[], reversal: boolean): void {
  for (const r of rows) {
    const units = BigInt(r.units ?? 0)
    if (reversal) {
      if (r.kind === 'SALE') totals.reversedSaleUnits += units
      continue
    }
    if (r.kind === 'SALE') {
      totals.saleUnits += units
      totals.saleCount += Number(r.cnt ?? 0)
    } else if (r.kind === 'PROMO') totals.promoUnits += units
    else if (r.kind === 'WRITE_OFF') totals.writeOffUnits += units
    else totals.internalUnits += units
  }
}

export const treasuryFlowService = {
  /** Period totals by effective classification, used by the imputed-cash report. */
  async periodTotals(params: { from?: Date; to?: Date }): Promise<TreasuryFlowTotals> {
    const house = await ledgerAccountRoleService.getHouseAccounts()
    if (house.allIds.size === 0) return { ...ZERO_TREASURY_TOTALS }

    const ids = idList(house)
    const kind = kindSql(ids)
    const { from, to } = params

    // A sale created and reversed inside the same window nets to zero, so it is
    // dropped from both the sale line and the reversal line rather than shown as churn.
    const sameWindowReversal = Prisma.sql`
      t2.reversed_at IS NOT NULL
      ${from ? Prisma.sql`AND t2.reversed_at >= ${from}` : Prisma.empty}
      ${to ? Prisma.sql`AND t2.reversed_at < ${to}` : Prisma.empty}`

    const [coinCreated, pointCreated, coinReversed] = await Promise.all([
      prismaRead.$queryRaw<AggRow[]>(Prisma.sql`
        SELECT ${kind} AS kind,
               SUM(t2.trading_coins_debited) AS units,
               COUNT(*) AS cnt
        FROM coin_trading_transfers t2
        LEFT JOIN treasury_flow_classifications c
          ON c.flow_kind = 'COIN_TRADING_TRANSFER' AND c.flow_id = t2.id
        WHERE t2.sender_agent_user_id IN (${ids})
          AND NOT (${sameWindowReversal})
          ${windowSql(Prisma.sql`t2.created_at`, from, to)}
        GROUP BY 1
      `),
      prismaRead.$queryRaw<AggRow[]>(Prisma.sql`
        SELECT CASE WHEN t2.recipient_agent_user_id IN (${ids}) THEN 'INTERNAL'
                    ELSE COALESCE(c.classification::text, 'SALE') END AS kind,
               SUM(t2.points) AS units,
               COUNT(*) AS cnt
        FROM agent_point_transfers t2
        LEFT JOIN treasury_flow_classifications c
          ON c.flow_kind = 'AGENT_POINT_TRANSFER' AND c.flow_id = t2.id
        WHERE t2.sender_agent_user_id IN (${ids})
          ${windowSql(Prisma.sql`t2.created_at`, from, to)}
        GROUP BY 1
      `),
      // Reversals of sales booked in an earlier period.
      prismaRead.$queryRaw<AggRow[]>(Prisma.sql`
        SELECT ${kind} AS kind,
               SUM(t2.trading_coins_debited) AS units,
               COUNT(*) AS cnt
        FROM coin_trading_transfers t2
        LEFT JOIN treasury_flow_classifications c
          ON c.flow_kind = 'COIN_TRADING_TRANSFER' AND c.flow_id = t2.id
        WHERE t2.sender_agent_user_id IN (${ids})
          AND t2.reversed_at IS NOT NULL
          ${windowSql(Prisma.sql`t2.reversed_at`, from, to)}
          AND NOT (TRUE
            ${from ? Prisma.sql`AND t2.created_at >= ${from}` : Prisma.empty}
            ${to ? Prisma.sql`AND t2.created_at < ${to}` : Prisma.empty})
        GROUP BY 1
      `),
    ])

    const totals: TreasuryFlowTotals = { ...ZERO_TREASURY_TOTALS }
    applyAgg(totals, coinCreated, false)
    applyAgg(totals, pointCreated, false)
    applyAgg(totals, coinReversed, true)
    return totals
  },

  /** Paginated treasury outflow feed for the admin Currency page. */
  async list(params: {
    from?: Date
    to?: Date
    classification?: TreasuryFlowClassificationType
    senderUserId?: string
    limit: number
    cursor?: string
  }) {
    const house = await ledgerAccountRoleService.getHouseAccounts()
    if (house.allIds.size === 0) {
      return { entries: [], nextCursor: null, hasMore: false, houseAccountCount: 0 }
    }

    const decoded = params.cursor ? decodeCursor(params.cursor) : null
    if (params.cursor && !decoded) {
      throw new AppError(400, 'Invalid cursor', 'INVALID_REQUEST')
    }

    const ids = idList(house)
    const kind = kindSql(ids)
    const take = params.limit + 1
    const sender = params.senderUserId
      ? Prisma.sql`AND t2.sender_agent_user_id = ${params.senderUserId}::uuid`
      : Prisma.empty
    const cursorFilter = decoded
      ? Prisma.sql`AND (t2.created_at < ${decoded.t}
          OR (t2.created_at = ${decoded.t} AND t2.id::text < ${decoded.id}))`
      : Prisma.empty
    const classFilter = params.classification
      ? Prisma.sql`AND ${kind} = ${params.classification}`
      : Prisma.empty
    const pointKind = Prisma.sql`
      CASE WHEN t2.recipient_agent_user_id IN (${ids}) THEN 'INTERNAL'
           ELSE COALESCE(c.classification::text, 'SALE') END`
    const pointClassFilter = params.classification
      ? Prisma.sql`AND ${pointKind} = ${params.classification}`
      : Prisma.empty

    const [coinRows, pointRows] = await Promise.all([
      prismaRead.$queryRaw<FlowRow[]>(Prisma.sql`
        SELECT 'COIN_TRADING_TRANSFER'::text AS flow_kind,
               t2.id::text                   AS flow_id,
               t2.sender_agent_user_id::text AS sender_user_id,
               t2.recipient_user_id::text    AS recipient_user_id,
               t2.trading_coins_debited      AS units,
               c.classification::text        AS classification,
               ${kind}                       AS kind,
               t2.reversed_at                AS reversed_at,
               t2.created_at                 AS created_at
        FROM coin_trading_transfers t2
        LEFT JOIN treasury_flow_classifications c
          ON c.flow_kind = 'COIN_TRADING_TRANSFER' AND c.flow_id = t2.id
        WHERE t2.sender_agent_user_id IN (${ids})
          ${sender}
          ${cursorFilter}
          ${classFilter}
          ${windowSql(Prisma.sql`t2.created_at`, params.from, params.to)}
        ORDER BY t2.created_at DESC, t2.id DESC
        LIMIT ${take}
      `),
      prismaRead.$queryRaw<FlowRow[]>(Prisma.sql`
        SELECT 'AGENT_POINT_TRANSFER'::text     AS flow_kind,
               t2.id::text                      AS flow_id,
               t2.sender_agent_user_id::text    AS sender_user_id,
               t2.recipient_agent_user_id::text AS recipient_user_id,
               t2.points                        AS units,
               c.classification::text           AS classification,
               ${pointKind}                     AS kind,
               NULL::timestamp                  AS reversed_at,
               t2.created_at                    AS created_at
        FROM agent_point_transfers t2
        LEFT JOIN treasury_flow_classifications c
          ON c.flow_kind = 'AGENT_POINT_TRANSFER' AND c.flow_id = t2.id
        WHERE t2.sender_agent_user_id IN (${ids})
          ${sender}
          ${cursorFilter}
          ${pointClassFilter}
          ${windowSql(Prisma.sql`t2.created_at`, params.from, params.to)}
        ORDER BY t2.created_at DESC, t2.id DESC
        LIMIT ${take}
      `),
    ])

    const merged = [...coinRows, ...pointRows].sort((a, b) => {
      const dt = b.created_at.getTime() - a.created_at.getTime()
      if (dt !== 0) return dt
      return b.flow_id < a.flow_id ? -1 : b.flow_id > a.flow_id ? 1 : 0
    })

    const hasMore = merged.length > params.limit
    const page = hasMore ? merged.slice(0, params.limit) : merged

    const userIds = [...new Set(page.flatMap((r) => [r.sender_user_id, r.recipient_user_id]))]
    const users =
      userIds.length === 0
        ? []
        : await prismaRead.user.findMany({
            where: { id: { in: userIds } },
            select: userSelect,
          })
    const userById = new Map(users.map((u) => [u.id, u]))

    const brief = (id: string) => {
      const u = userById.get(id)
      if (!u) return null
      return {
        userId: u.id,
        username: u.username,
        name: formatUserName(u),
        displayName: buildUserDisplayName(u),
        publicId: u.publicId.toString(),
        avatarUrl: u.avatarUrl,
        isAgent: u.isAgent,
        isHouse: house.allIds.has(u.id),
      }
    }

    const last = page[page.length - 1]
    return {
      entries: page.map((r) => {
        const units = BigInt(r.units ?? 0)
        return {
          flowKind: r.flow_kind,
          flowId: r.flow_id,
          units: units.toString(),
          usd: unitsToUsd(units),
          classification: r.kind,
          /** Null when the row is on the SALE default with no admin override. */
          storedClassification: r.classification,
          /** INTERNAL derived from a house recipient cannot be overridden. */
          locked: house.allIds.has(r.recipient_user_id),
          reversedAt: r.reversed_at ? r.reversed_at.toISOString() : null,
          createdAt: r.created_at.toISOString(),
          sender: brief(r.sender_user_id),
          recipient: brief(r.recipient_user_id),
        }
      }),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.flow_id) : null,
      hasMore,
      houseAccountCount: house.allIds.size,
    }
  },

  async classify(params: {
    adminUserId: string
    flowKind: TreasuryFlowKind
    flowId: string
    classification: TreasuryFlowClassificationType
    reason?: string
  }) {
    const house = await ledgerAccountRoleService.getHouseAccounts()
    const flow = await findFlow(params.flowKind, params.flowId)
    if (!flow) throw new AppError(404, 'Treasury flow not found', 'FLOW_NOT_FOUND')
    if (!house.allIds.has(flow.senderUserId)) {
      throw new AppError(
        400,
        'Flow sender is not a registered house account',
        'NOT_A_TREASURY_FLOW',
      )
    }
    if (house.allIds.has(flow.recipientUserId)) {
      throw new AppError(
        400,
        'House-to-house flows are always INTERNAL and cannot be reclassified',
        'FLOW_CLASSIFICATION_LOCKED',
      )
    }

    const row = await prisma.treasuryFlowClassification.upsert({
      where: { flowKind_flowId: { flowKind: params.flowKind, flowId: params.flowId } },
      create: {
        flowKind: params.flowKind,
        flowId: params.flowId,
        classification: params.classification,
        reason: params.reason ?? null,
        adminUserId: params.adminUserId,
      },
      update: {
        classification: params.classification,
        reason: params.reason ?? null,
        adminUserId: params.adminUserId,
      },
    })

    return {
      ok: true as const,
      flowKind: row.flowKind,
      flowId: row.flowId,
      classification: row.classification,
    }
  },
}

async function findFlow(
  kind: TreasuryFlowKind,
  id: string,
): Promise<{ senderUserId: string; recipientUserId: string } | null> {
  if (kind === TreasuryFlowKind.COIN_TRADING_TRANSFER) {
    const row = await prismaRead.coinTradingTransfer.findUnique({
      where: { id },
      select: { senderAgentUserId: true, recipientUserId: true },
    })
    return row
      ? { senderUserId: row.senderAgentUserId, recipientUserId: row.recipientUserId }
      : null
  }
  const row = await prismaRead.agentPointTransfer.findUnique({
    where: { id },
    select: { senderAgentUserId: true, recipientAgentUserId: true },
  })
  return row
    ? { senderUserId: row.senderAgentUserId, recipientUserId: row.recipientAgentUserId }
    : null
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  )
}

function decodeCursor(cursor: string): { t: Date; id: string } | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: string
      id?: string
    }
    if (!raw.t || !raw.id) return null
    const t = new Date(raw.t)
    if (Number.isNaN(t.getTime())) return null
    return { t, id: raw.id }
  } catch {
    return null
  }
}
