import { prisma } from '../config/database'
import type { LedgerAuditFlagDraft } from '../services/ledger-audit/ledger-audit.types'
import type { LedgerAuditStatus, Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'

const BATCH = 200

export const ledgerAuditRepository = {
  async createFlagsSkipDuplicates(drafts: LedgerAuditFlagDraft[]): Promise<number> {
    if (drafts.length === 0) return 0
    let created = 0
    for (let i = 0; i < drafts.length; i += BATCH) {
      const chunk = drafts.slice(i, i + BATCH)
      const result = await prisma.ledgerAuditFlag.createMany({
        data: chunk.map((d) => ({
          id: randomUUID(),
          userId: d.userId,
          category: d.category,
          code: d.code,
          severity: d.severity,
          fingerprint: d.fingerprint,
          summary: d.summary,
          evidence: d.evidence,
          ledgerEntryId: d.ledgerEntryId ?? null,
          pointLedgerEntryId: d.pointLedgerEntryId ?? null,
          vipPurchaseId: d.vipPurchaseId ?? null,
          windowStart: d.windowStart,
          windowEnd: d.windowEnd,
        })),
        skipDuplicates: true,
      })
      created += result.count
    }
    return created
  },

  async findFlagById(id: string) {
    return prisma.ledgerAuditFlag.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            publicId: true,
            currentVipPublicId: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    })
  },

  async updateFlagStatus(args: {
    id: string
    status: LedgerAuditStatus
    resolvedByAdminId: string
    resolutionNote?: string | null
  }) {
    return prisma.ledgerAuditFlag.update({
      where: { id: args.id },
      data: {
        status: args.status,
        resolvedAt: args.status === 'OPEN' ? null : new Date(),
        resolvedByAdminId: args.status === 'OPEN' ? null : args.resolvedByAdminId,
        resolutionNote: args.resolutionNote ?? null,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            publicId: true,
            currentVipPublicId: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    })
  },

  async listFlags(args: { where: Prisma.LedgerAuditFlagWhereInput; skip: number; take: number }) {
    const [items, total] = await Promise.all([
      prisma.ledgerAuditFlag.findMany({
        where: args.where,
        orderBy: { createdAt: 'desc' },
        skip: args.skip,
        take: args.take,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              publicId: true,
              currentVipPublicId: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      prisma.ledgerAuditFlag.count({ where: args.where }),
    ])
    return { items, total }
  },

  async resolveUserIdsByQuery(args: {
    q: string
    qType: 'auto' | 'userId' | 'publicId' | 'displayId'
  }): Promise<string[]> {
    const q = args.q.trim()
    if (!q) return []

    const asUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(q)
    const asBigInt = /^\d+$/.test(q) ? BigInt(q) : null

    const tryUserId = async () => {
      if (!asUuid) return [] as string[]
      const u = await prisma.user.findUnique({ where: { id: q }, select: { id: true } })
      return u ? [u.id] : []
    }
    const tryPublicId = async () => {
      if (asBigInt == null) return [] as string[]
      const u = await prisma.user.findUnique({
        where: { publicId: asBigInt },
        select: { id: true },
      })
      return u ? [u.id] : []
    }
    const tryDisplayId = async () => {
      if (asBigInt == null) return [] as string[]
      const byVip = await prisma.user.findFirst({
        where: { currentVipPublicId: asBigInt },
        select: { id: true },
      })
      if (byVip) return [byVip.id]
      return tryPublicId()
    }

    switch (args.qType) {
      case 'userId':
        return tryUserId()
      case 'publicId':
        return tryPublicId()
      case 'displayId':
        return tryDisplayId()
      case 'auto':
      default: {
        if (asUuid) {
          const ids = await tryUserId()
          if (ids.length) return ids
        }
        if (asBigInt != null) {
          const display = await tryDisplayId()
          if (display.length) return display
          return tryPublicId()
        }
        return []
      }
    }
  },
}
