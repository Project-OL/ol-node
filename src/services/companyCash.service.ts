import {
  CompanyCashDirection,
  CompanyCashReason,
  Prisma,
  WalletCurrencyType,
} from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import { companyCashRepository } from '../repositories/companyCash.repository'
import { formatUserName } from '../utils/user-display'
import { prismaRead } from '../config/database'

const userSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  publicId: true,
} as const

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  )
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: string
      id?: string
    }
    if (!raw.t || !raw.id) return null
    const createdAt = new Date(raw.t)
    if (Number.isNaN(createdAt.getTime())) return null
    return { createdAt, id: raw.id }
  } catch {
    return null
  }
}

function mapEntry(
  row: Awaited<ReturnType<typeof companyCashRepository.list>>[number],
  userById: Map<string, { name: string; publicId: string; username: string }>,
) {
  const counterparty = row.counterpartyUserId ? userById.get(row.counterpartyUserId) : undefined
  return {
    id: row.id,
    direction: row.direction,
    reason: row.reason,
    amountUsd: row.amountUsd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') || '0',
    amountUsdDisplay: row.amountUsd.toFixed(2),
    unitsAmount: row.unitsAmount?.toString() ?? null,
    currencyType: row.currencyType,
    counterpartyUserId: row.counterpartyUserId,
    counterparty: counterparty ?? null,
    ledgerRefId: row.ledgerRefId,
    withdrawalId: row.withdrawalId,
    description: row.description,
    promotional: row.promotional,
    adminUserId: row.adminUserId,
    createdAt: row.createdAt.toISOString(),
  }
}

export const companyCashService = {
  async record(input: Parameters<typeof companyCashRepository.create>[0], tx?: Prisma.TransactionClient) {
    if (new Prisma.Decimal(input.amountUsd.toString()).lte(0)) {
      throw new AppError(400, 'Cash amount must be positive', 'INVALID_REQUEST')
    }
    return companyCashRepository.create(input, tx)
  },

  async list(params: {
    from?: Date
    to?: Date
    reason?: CompanyCashReason
    direction?: CompanyCashDirection
    cursor?: string
    limit: number
  }) {
    const decoded = params.cursor ? decodeCursor(params.cursor) : null
    if (params.cursor && !decoded) {
      throw new AppError(400, 'Invalid cursor', 'INVALID_REQUEST')
    }
    const limit = params.limit
    const rows = await companyCashRepository.list({
      from: params.from,
      to: params.to,
      reason: params.reason,
      direction: params.direction,
      cursor: decoded ?? undefined,
      limit: limit + 1,
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const userIds = [...new Set(page.map((r) => r.counterpartyUserId).filter(Boolean))] as string[]
    const users =
      userIds.length === 0
        ? []
        : await prismaRead.user.findMany({
            where: { id: { in: userIds } },
            select: userSelect,
          })
    const userById = new Map(
      users.map((u) => [
        u.id,
        {
          name: formatUserName(u),
          publicId: u.publicId.toString(),
          username: u.username,
        },
      ]),
    )
    const nextCursor =
      hasMore && page.length > 0
        ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id)
        : null
    return {
      entries: page.map((r) => mapEntry(r, userById)),
      nextCursor,
      hasMore,
    }
  },

  async periodCash(params: { from?: Date; to?: Date }) {
    const [cashIn, cashOut] = await Promise.all([
      companyCashRepository.sumUsd({
        from: params.from,
        to: params.to,
        direction: CompanyCashDirection.IN,
      }),
      companyCashRepository.sumUsd({
        from: params.from,
        to: params.to,
        direction: CompanyCashDirection.OUT,
      }),
    ])
    const profit = cashIn.sub(cashOut)
    return {
      capitalInUsd: cashIn.toFixed(2),
      cashOutUsd: cashOut.toFixed(2),
      cashProfitUsd: profit.toFixed(2),
    }
  },
}

export { CompanyCashDirection, CompanyCashReason, WalletCurrencyType }
