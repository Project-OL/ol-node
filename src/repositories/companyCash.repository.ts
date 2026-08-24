import { CompanyCashDirection, CompanyCashReason, Prisma, WalletCurrencyType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type CompanyCashCreateInput = {
  direction: CompanyCashDirection
  reason: CompanyCashReason
  amountUsd: Prisma.Decimal | string | number
  unitsAmount?: bigint | null
  currencyType?: WalletCurrencyType | null
  counterpartyUserId?: string | null
  ledgerRefId?: string | null
  withdrawalId?: string | null
  description?: string | null
  promotional?: boolean
  adminUserId: string
}

function dateFilter(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lt: to } : {}),
  }
}

export const companyCashRepository = {
  async create(data: CompanyCashCreateInput, tx?: Prisma.TransactionClient) {
    const db = tx ?? prisma
    return db.companyCashEntry.create({
      data: {
        direction: data.direction,
        reason: data.reason,
        amountUsd: data.amountUsd,
        unitsAmount: data.unitsAmount ?? null,
        currencyType: data.currencyType ?? null,
        counterpartyUserId: data.counterpartyUserId ?? null,
        ledgerRefId: data.ledgerRefId ?? null,
        withdrawalId: data.withdrawalId ?? null,
        description: data.description ?? null,
        promotional: data.promotional ?? false,
        adminUserId: data.adminUserId,
      },
    })
  },

  async findByWithdrawalReason(withdrawalId: string, reason: CompanyCashReason) {
    return prismaRead.companyCashEntry.findFirst({
      where: { withdrawalId, reason },
      orderBy: { createdAt: 'desc' },
    })
  },

  async list(params: {
    from?: Date
    to?: Date
    reason?: CompanyCashReason
    direction?: CompanyCashDirection
    cursor?: { createdAt: Date; id: string }
    limit: number
  }) {
    const createdAt = dateFilter(params.from, params.to)
    return prismaRead.companyCashEntry.findMany({
      where: {
        ...(createdAt ? { createdAt } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.direction ? { direction: params.direction } : {}),
        ...(params.cursor
          ? {
              OR: [
                { createdAt: { lt: params.cursor.createdAt } },
                { createdAt: params.cursor.createdAt, id: { lt: params.cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.limit,
    })
  },

  async sumUsd(params: {
    from?: Date
    to?: Date
    direction: CompanyCashDirection
    reasons?: CompanyCashReason[]
  }) {
    const createdAt = dateFilter(params.from, params.to)
    const agg = await prismaRead.companyCashEntry.aggregate({
      where: {
        direction: params.direction,
        promotional: false,
        ...(createdAt ? { createdAt } : {}),
        ...(params.reasons?.length ? { reason: { in: params.reasons } } : {}),
      },
      _sum: { amountUsd: true },
    })
    return agg._sum.amountUsd ?? new Prisma.Decimal(0)
  },
}
