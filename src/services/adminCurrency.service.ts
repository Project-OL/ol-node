import {
  CoinTxType,
  LedgerDirection,
  PointTxType,
  Prisma,
  WalletCurrencyType,
} from '@prisma/client'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import type {
  AdminCurrencyAdjustBody,
  AdminCurrencyAdjustmentsQuery,
  AdminCurrencySupplySummaryQuery,
} from '../models/admin-currency.schemas'
import { buildUserDisplayName, formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import { adminWalletService } from './adminWallet.service'
import { adminAuditMetaFromRequest } from '../utils/admin-audit'
import { platformProfitService } from './platform-profit.service'

const userSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect

type AdjustmentUser = {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  avatarUrl: string | null
}

type AdjustmentSource = 'COIN' | 'POINT' | 'TRADING_COIN' | 'DIAMOND'

type AdjustmentRow = {
  id: string
  source: AdjustmentSource
  direction: LedgerDirection
  amount: bigint
  balanceAfter: bigint
  description: string | null
  createdAt: Date
  user: AdjustmentUser
}

function encodeCursor(row: AdjustmentRow): string {
  return Buffer.from(
    JSON.stringify({ t: row.createdAt.toISOString(), id: row.id, s: row.source }),
    'utf8',
  ).toString('base64url')
}

function decodeCursor(cursor: string): { t: Date; id: string; s: AdjustmentSource } | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: string
      id?: string
      s?: AdjustmentSource
    }
    if (!raw.t || !raw.id || !raw.s) return null
    const t = new Date(raw.t)
    if (Number.isNaN(t.getTime())) return null
    if (raw.s !== 'COIN' && raw.s !== 'POINT' && raw.s !== 'TRADING_COIN' && raw.s !== 'DIAMOND') {
      return null
    }
    return { t, id: raw.id, s: raw.s }
  } catch {
    return null
  }
}

function mapUserBrief(u: AdjustmentUser) {
  return {
    userId: u.id,
    username: u.username,
    name: formatUserName(u),
    displayName: buildUserDisplayName(u),
    publicId: String(u.publicId),
    displayPublicId: resolveDisplayPublicId(u),
    avatarUrl: u.avatarUrl,
  }
}

export const adminCurrencyService = {
  async adjust(params: {
    adminUserId: string
    body: AdminCurrencyAdjustBody
    auditMeta?: ReturnType<typeof adminAuditMetaFromRequest>
  }) {
    const amount = BigInt(params.body.amount)
    const { userId, currency, direction, description, idempotencyKey, forceTradingCredit } =
      params.body
    const promotional = params.body.promotional === true

    if (direction === 'credit') {
      if (currency === 'COIN') {
        return adminWalletService.creditUserWallets({
          adminUserId: params.adminUserId,
          targetUserId: userId,
          coins: amount,
          description,
          idempotencyKey,
          promotional,
          auditMeta: params.auditMeta,
        })
      }
      if (currency === 'POINT') {
        return adminWalletService.creditUserWallets({
          adminUserId: params.adminUserId,
          targetUserId: userId,
          points: amount,
          description,
          idempotencyKey,
          promotional,
          auditMeta: params.auditMeta,
        })
      }
      if (currency === 'DIAMOND') {
        return adminWalletService.creditUserWallets({
          adminUserId: params.adminUserId,
          targetUserId: userId,
          diamonds: amount,
          description,
          idempotencyKey,
          promotional,
          auditMeta: params.auditMeta,
        })
      }
      // No cash-in row is written any more. Under the treasury imputed-ledger
      // model, revenue comes from units leaving a house account at 10,000 = $1;
      // pairing a USD figure to the mint as well would double count.
      return adminWalletService.creditUserWallets({
        adminUserId: params.adminUserId,
        targetUserId: userId,
        tradingCoins: amount,
        description,
        idempotencyKey,
        forceTradingCredit,
        promotional,
        auditMeta: params.auditMeta,
      })
    }

    if (currency === 'COIN') {
      return adminWalletService.debitPersonalCoins({
        adminUserId: params.adminUserId,
        targetUserId: userId,
        amount,
        description,
        idempotencyKey,
        auditMeta: params.auditMeta,
      })
    }
    if (currency === 'POINT') {
      return adminWalletService.debitPoints({
        adminUserId: params.adminUserId,
        targetUserId: userId,
        amount,
        description,
        idempotencyKey,
        auditMeta: params.auditMeta,
      })
    }
    if (currency === 'DIAMOND') {
      return adminWalletService.debitDiamonds({
        adminUserId: params.adminUserId,
        targetUserId: userId,
        amount,
        description,
        idempotencyKey,
        auditMeta: params.auditMeta,
      })
    }
    return adminWalletService.debitTradingCoins({
      adminUserId: params.adminUserId,
      targetUserId: userId,
      amount,
      description,
      idempotencyKey,
      auditMeta: params.auditMeta,
    })
  },

  async supplySummary(query: AdminCurrencySupplySummaryQuery) {
    const summary = await platformProfitService.summarizeAdminCurrencySupply({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    })
    return summary
  },

  async listAdjustments(query: AdminCurrencyAdjustmentsQuery) {
    const limit = query.limit
    const from = query.from ? new Date(query.from) : undefined
    const to = query.to ? new Date(query.to) : undefined
    const cursor = query.cursor ? decodeCursor(query.cursor) : null
    if (query.cursor && !cursor) {
      throw new AppError(400, 'Invalid cursor', 'INVALID_REQUEST')
    }

    const sources: AdjustmentSource[] = query.currency
      ? [query.currency]
      : ['COIN', 'POINT', 'TRADING_COIN', 'DIAMOND']

    const fetchLimit = limit + 1
    const rows: AdjustmentRow[] = []

    for (const source of sources) {
      if (source === 'POINT') {
        const pointWhere: Prisma.PointLedgerEntryWhereInput = {
          txType: PointTxType.ADJUSTMENT,
          ...(query.direction
            ? {
                direction:
                  query.direction === 'credit' ? LedgerDirection.CREDIT : LedgerDirection.DEBIT,
              }
            : {}),
          ...(query.userId ? { wallet: { userId: query.userId } } : {}),
          ...(from || to
            ? {
                createdAt: {
                  ...(from ? { gte: from } : {}),
                  ...(to ? { lte: to } : {}),
                },
              }
            : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.t } },
                  { createdAt: cursor.t, id: { lt: cursor.id } },
                ],
              }
            : {}),
        }
        const pointRows = await prismaRead.pointLedgerEntry.findMany({
          where: pointWhere,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: fetchLimit,
          select: {
            id: true,
            direction: true,
            amount: true,
            balanceAfter: true,
            description: true,
            createdAt: true,
            wallet: { select: { user: { select: userSelect } } },
          },
        })
        for (const r of pointRows) {
          rows.push({
            id: r.id,
            source: 'POINT',
            direction: r.direction,
            amount: r.amount,
            balanceAfter: r.balanceAfter,
            description: r.description,
            createdAt: r.createdAt,
            user: r.wallet.user,
          })
        }
        continue
      }

      const currencyType =
        source === 'TRADING_COIN'
          ? WalletCurrencyType.TRADING_COIN
          : source === 'DIAMOND'
            ? WalletCurrencyType.DIAMOND
            : WalletCurrencyType.COIN
      // Admin diamond adjustments use the dedicated GAME_ADJUSTMENT tx type (shared with
      // no other flow), so they don't collide with real settlement rows on the same wallet.
      const txType = source === 'DIAMOND' ? CoinTxType.GAME_ADJUSTMENT : CoinTxType.ADJUSTMENT
      const coinWhere: Prisma.CoinLedgerEntryWhereInput = {
        txType,
        wallet: {
          currencyType,
          ...(query.userId ? { userId: query.userId } : {}),
        },
        ...(query.direction
          ? {
              direction:
                query.direction === 'credit' ? LedgerDirection.CREDIT : LedgerDirection.DEBIT,
            }
          : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
        ...(cursor
          ? {
              OR: [{ createdAt: { lt: cursor.t } }, { createdAt: cursor.t, id: { lt: cursor.id } }],
            }
          : {}),
      }
      const coinRows = await prismaRead.coinLedgerEntry.findMany({
        where: coinWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: fetchLimit,
        select: {
          id: true,
          direction: true,
          amount: true,
          balanceAfter: true,
          description: true,
          createdAt: true,
          wallet: { select: { user: { select: userSelect } } },
        },
      })
      for (const r of coinRows) {
        rows.push({
          id: r.id,
          source,
          direction: r.direction,
          amount: r.amount,
          balanceAfter: r.balanceAfter,
          description: r.description,
          createdAt: r.createdAt,
          user: r.wallet.user,
        })
      }
    }

    rows.sort((a, b) => {
      const dt = b.createdAt.getTime() - a.createdAt.getTime()
      if (dt !== 0) return dt
      return b.id < a.id ? -1 : b.id > a.id ? 1 : 0
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null

    return {
      entries: page.map((r) => ({
        id: r.id,
        currency: r.source,
        direction: r.direction,
        amount: r.amount.toString(),
        balanceAfter: r.balanceAfter.toString(),
        description: r.description,
        createdAt: r.createdAt.toISOString(),
        user: mapUserBrief(r.user),
        supplyEffect: r.direction === LedgerDirection.CREDIT ? 'created' : 'returned',
      })),
      nextCursor,
      hasMore,
    }
  },
}
