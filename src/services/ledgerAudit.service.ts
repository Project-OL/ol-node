import { CoinTxType, LedgerDirection, type Prisma, WalletCurrencyType } from '@prisma/client'
import { prisma } from '../config/database'
import { ledgerAuditRepository } from '../repositories/ledgerAudit.repository'
import {
  classifyCoinLedgerOrigin,
  classifyPointLedgerOrigin,
} from './ledger-audit/ledger-origin.classifier'
import { LEDGER_AUDIT_CODES, type LedgerAuditFlagDraft } from './ledger-audit/ledger-audit.types'
import {
  auditUtcDayKey,
  reconstructVipExpiresAt,
  vipExpiresDisagree,
  type VipPurchaseReplayRow,
} from './ledger-audit/vip-audit.helpers'
import {
  checkLedgerBalanceChain,
  pointLedgerBalanceCarriesForward,
} from './ledger-audit/ledger-balance-chain.helpers'
import { formatUserName } from '../utils/user-display'

const LOOKBACK_MS = 26 * 60 * 60 * 1000
const PAGE = 500
const VIP_USER_PAGE = 200

function userSnapshot(u: {
  id: string
  username: string
  publicId: bigint
  currentVipPublicId: bigint | null
  firstName: string | null
  lastName: string | null
  vipSubscriptionActive: boolean
  vipSubscriptionExpiresAt: Date | null
}) {
  return {
    userId: u.id,
    username: u.username,
    publicId: u.publicId.toString(),
    currentVipPublicId: u.currentVipPublicId?.toString() ?? null,
    firstName: u.firstName,
    lastName: u.lastName,
    name: formatUserName(u),
    vipSubscriptionActive: u.vipSubscriptionActive,
    vipSubscriptionExpiresAt: u.vipSubscriptionExpiresAt?.toISOString() ?? null,
  }
}

async function loadUserMap(userIds: string[]) {
  if (userIds.length === 0)
    return new Map<string, Awaited<ReturnType<typeof prisma.user.findMany>>[number]>()
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(userIds)] } },
    select: {
      id: true,
      username: true,
      publicId: true,
      currentVipPublicId: true,
      firstName: true,
      lastName: true,
      vipSubscriptionActive: true,
      vipSubscriptionExpiresAt: true,
    },
  })
  return new Map(users.map((u) => [u.id, u]))
}

export type LedgerAuditRunResult = {
  windowStart: string
  windowEnd: string
  flagsCreated: number
  draftsConsidered: number
  coinEntriesScanned: number
  pointEntriesScanned: number
  coinBalanceLinksChecked: number
  pointBalanceLinksChecked: number
  vipUsersChecked: number
}

export const ledgerAuditService = {
  defaultWindow(now = new Date()): { windowStart: Date; windowEnd: Date } {
    return { windowEnd: now, windowStart: new Date(now.getTime() - LOOKBACK_MS) }
  },

  async runOvernightAudit(opts?: {
    windowStart?: Date
    windowEnd?: Date
  }): Promise<LedgerAuditRunResult> {
    const windowEnd = opts?.windowEnd ?? new Date()
    const windowStart = opts?.windowStart ?? new Date(windowEnd.getTime() - LOOKBACK_MS)
    const dayKey = auditUtcDayKey(windowEnd)

    const drafts: LedgerAuditFlagDraft[] = []
    let coinEntriesScanned = 0
    let pointEntriesScanned = 0
    let coinBalanceLinksChecked = 0
    let pointBalanceLinksChecked = 0
    let vipUsersChecked = 0

    coinEntriesScanned += await this.scanCoinLedgers(windowStart, windowEnd, drafts)
    pointEntriesScanned += await this.scanPointLedgers(windowStart, windowEnd, drafts)
    coinBalanceLinksChecked += await this.scanCoinBalanceChains(windowStart, windowEnd, drafts)
    pointBalanceLinksChecked += await this.scanPointBalanceChains(windowStart, windowEnd, drafts)
    vipUsersChecked += await this.scanVipEntitlements(windowStart, windowEnd, dayKey, drafts)

    const flagsCreated = await ledgerAuditRepository.createFlagsSkipDuplicates(drafts)

    return {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      flagsCreated,
      draftsConsidered: drafts.length,
      coinEntriesScanned,
      pointEntriesScanned,
      coinBalanceLinksChecked,
      pointBalanceLinksChecked,
      vipUsersChecked,
    }
  },

  async scanCoinLedgers(
    windowStart: Date,
    windowEnd: Date,
    drafts: LedgerAuditFlagDraft[],
  ): Promise<number> {
    let scanned = 0
    let skip = 0
    for (;;) {
      const rows = await prisma.coinLedgerEntry.findMany({
        where: { createdAt: { gte: windowStart, lte: windowEnd } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take: PAGE,
        include: {
          wallet: { select: { userId: true, currencyType: true } },
          vipMembershipPurchases: { select: { id: true } },
        },
      })
      if (rows.length === 0) break
      scanned += rows.length
      skip += rows.length

      const userMap = await loadUserMap(rows.map((r) => r.wallet.userId))

      for (const row of rows) {
        const userId = row.wallet.userId
        const user = userMap.get(userId)
        const category =
          row.wallet.currencyType === WalletCurrencyType.TRADING_COIN
            ? ('TRADING_COIN' as const)
            : ('COIN' as const)

        if (
          row.txType === CoinTxType.VIP_MEMBERSHIP_PURCHASE &&
          row.direction === LedgerDirection.DEBIT &&
          row.vipMembershipPurchases.length === 0
        ) {
          drafts.push({
            userId,
            category: 'VIP',
            code: LEDGER_AUDIT_CODES.VIP_LEDGER_WITHOUT_PURCHASE,
            severity: 'CRITICAL',
            fingerprint: `${LEDGER_AUDIT_CODES.VIP_LEDGER_WITHOUT_PURCHASE}:${row.id}`,
            summary: 'VIP membership ledger debit has no matching purchase row',
            evidence: {
              ...(user ? userSnapshot(user) : { userId }),
              ledgerEntryId: row.id,
              txType: row.txType,
              direction: row.direction,
              amount: row.amount.toString(),
              balanceAfter: row.balanceAfter.toString(),
              idempotencyKey: row.idempotencyKey,
              metadata: row.metadata,
              description: row.description,
              createdAt: row.createdAt.toISOString(),
            },
            ledgerEntryId: row.id,
            windowStart,
            windowEnd,
          })
        }

        const origin = classifyCoinLedgerOrigin({
          idempotencyKey: row.idempotencyKey,
          metadata: row.metadata,
          txType: row.txType,
        })
        if (origin === 'APP') continue

        const code =
          origin === 'ADMIN'
            ? LEDGER_AUDIT_CODES.NON_APP_ADMIN_LEDGER
            : LEDGER_AUDIT_CODES.NON_APP_UNKNOWN_LEDGER
        const severity = origin === 'ADMIN' ? ('INFO' as const) : ('WARNING' as const)

        drafts.push({
          userId,
          category,
          code,
          severity,
          fingerprint: `${code}:${row.id}`,
          summary:
            origin === 'ADMIN'
              ? `Admin wallet ${row.direction.toLowerCase()} on ${category} ledger`
              : `Unattributed ${category} ledger entry (not matched to app flow)`,
          evidence: {
            ...(user ? userSnapshot(user) : { userId }),
            origin,
            ledgerEntryId: row.id,
            currencyType: row.wallet.currencyType,
            txType: row.txType,
            direction: row.direction,
            amount: row.amount.toString(),
            balanceAfter: row.balanceAfter.toString(),
            idempotencyKey: row.idempotencyKey,
            metadata: row.metadata,
            description: row.description,
            createdAt: row.createdAt.toISOString(),
          },
          ledgerEntryId: row.id,
          windowStart,
          windowEnd,
        })
      }

      if (rows.length < PAGE) break
    }
    return scanned
  },

  async scanPointLedgers(
    windowStart: Date,
    windowEnd: Date,
    drafts: LedgerAuditFlagDraft[],
  ): Promise<number> {
    let scanned = 0
    let skip = 0
    for (;;) {
      const rows = await prisma.pointLedgerEntry.findMany({
        where: { createdAt: { gte: windowStart, lte: windowEnd } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take: PAGE,
        include: {
          wallet: { select: { userId: true } },
        },
      })
      if (rows.length === 0) break
      scanned += rows.length
      skip += rows.length

      const userMap = await loadUserMap(rows.map((r) => r.wallet.userId))

      for (const row of rows) {
        const userId = row.wallet.userId
        const user = userMap.get(userId)
        const origin = classifyPointLedgerOrigin({
          idempotencyKey: row.idempotencyKey,
          metadata: row.metadata,
          txType: row.txType,
        })
        if (origin === 'APP') continue

        const code =
          origin === 'ADMIN'
            ? LEDGER_AUDIT_CODES.NON_APP_ADMIN_LEDGER
            : LEDGER_AUDIT_CODES.NON_APP_UNKNOWN_LEDGER
        const severity = origin === 'ADMIN' ? ('INFO' as const) : ('WARNING' as const)

        drafts.push({
          userId,
          category: 'POINT',
          code,
          severity,
          fingerprint: `${code}:${row.id}`,
          summary:
            origin === 'ADMIN'
              ? 'Admin wallet adjustment on points ledger'
              : 'Unattributed points ledger entry (not matched to app flow)',
          evidence: {
            ...(user ? userSnapshot(user) : { userId }),
            origin,
            pointLedgerEntryId: row.id,
            txType: row.txType,
            direction: row.direction,
            amount: row.amount.toString(),
            balanceAfter: row.balanceAfter.toString(),
            idempotencyKey: row.idempotencyKey,
            metadata: row.metadata,
            description: row.description,
            createdAt: row.createdAt.toISOString(),
          },
          pointLedgerEntryId: row.id,
          windowStart,
          windowEnd,
        })
      }

      if (rows.length < PAGE) break
    }
    return scanned
  },

  /**
   * For every coin/trading-coin ledger row in the window: previous.balanceAfter ± amount
   * must equal this.balanceAfter (per wallet chain).
   */
  async scanCoinBalanceChains(
    windowStart: Date,
    windowEnd: Date,
    drafts: LedgerAuditFlagDraft[],
  ): Promise<number> {
    let checked = 0
    const walletGroups = await prisma.coinLedgerEntry.groupBy({
      by: ['walletId'],
      where: { createdAt: { gte: windowStart, lte: windowEnd } },
    })

    for (let i = 0; i < walletGroups.length; i += PAGE) {
      const batch = walletGroups.slice(i, i + PAGE)
      const walletIds = batch.map((g) => g.walletId)
      const wallets = await prisma.wallet.findMany({
        where: { id: { in: walletIds } },
        select: { id: true, userId: true, currencyType: true },
      })
      const walletMap = new Map(wallets.map((w) => [w.id, w]))
      const userMap = await loadUserMap(wallets.map((w) => w.userId))

      for (const walletId of walletIds) {
        const wallet = walletMap.get(walletId)
        if (!wallet) continue

        const entries = await prisma.coinLedgerEntry.findMany({
          where: {
            walletId,
            createdAt: { gte: windowStart, lte: windowEnd },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            direction: true,
            txType: true,
            amount: true,
            balanceAfter: true,
            idempotencyKey: true,
            metadata: true,
            description: true,
            createdAt: true,
          },
        })
        if (entries.length === 0) continue

        const first = entries[0]!
        const prior = await prisma.coinLedgerEntry.findFirst({
          where: {
            walletId,
            OR: [
              { createdAt: { lt: first.createdAt } },
              { createdAt: first.createdAt, id: { lt: first.id } },
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, balanceAfter: true },
        })

        let balanceBefore = prior?.balanceAfter ?? 0n
        let priorEntryId: string | null = prior?.id ?? null
        const category =
          wallet.currencyType === WalletCurrencyType.TRADING_COIN
            ? ('TRADING_COIN' as const)
            : ('COIN' as const)
        const user = userMap.get(wallet.userId)

        for (const entry of entries) {
          checked += 1
          const check = checkLedgerBalanceChain({
            balanceBefore,
            direction: entry.direction,
            amount: entry.amount,
            balanceAfter: entry.balanceAfter,
          })
          if (!check.ok) {
            drafts.push({
              userId: wallet.userId,
              category,
              code: LEDGER_AUDIT_CODES.LEDGER_BALANCE_CHAIN_BREAK,
              severity: 'CRITICAL',
              fingerprint: `${LEDGER_AUDIT_CODES.LEDGER_BALANCE_CHAIN_BREAK}:${entry.id}`,
              summary: `${category} ledger balanceAfter does not match prior balance ± amount`,
              evidence: {
                ...(user ? userSnapshot(user) : { userId: wallet.userId }),
                currencyType: wallet.currencyType,
                ledgerEntryId: entry.id,
                priorLedgerEntryId: priorEntryId,
                txType: entry.txType,
                direction: entry.direction,
                amount: entry.amount.toString(),
                balanceBefore: check.balanceBefore.toString(),
                expectedBalanceAfter: check.expectedBalanceAfter.toString(),
                actualBalanceAfter: check.actualBalanceAfter.toString(),
                balanceCarriesForward: check.balanceCarriesForward,
                idempotencyKey: entry.idempotencyKey,
                metadata: entry.metadata,
                description: entry.description,
                createdAt: entry.createdAt.toISOString(),
              },
              ledgerEntryId: entry.id,
              windowStart,
              windowEnd,
            })
          }
          // Next link uses the recorded balanceAfter (isolate each broken step).
          balanceBefore = entry.balanceAfter
          priorEntryId = entry.id
        }
      }
    }

    return checked
  },

  /**
   * Same chain check for points. `WITHDRAWAL_ESCROW` carries balance forward unchanged.
   */
  async scanPointBalanceChains(
    windowStart: Date,
    windowEnd: Date,
    drafts: LedgerAuditFlagDraft[],
  ): Promise<number> {
    let checked = 0
    const walletGroups = await prisma.pointLedgerEntry.groupBy({
      by: ['walletId'],
      where: { createdAt: { gte: windowStart, lte: windowEnd } },
    })

    for (let i = 0; i < walletGroups.length; i += PAGE) {
      const batch = walletGroups.slice(i, i + PAGE)
      const walletIds = batch.map((g) => g.walletId)
      const wallets = await prisma.wallet.findMany({
        where: { id: { in: walletIds } },
        select: { id: true, userId: true },
      })
      const walletMap = new Map(wallets.map((w) => [w.id, w]))
      const userMap = await loadUserMap(wallets.map((w) => w.userId))

      for (const walletId of walletIds) {
        const wallet = walletMap.get(walletId)
        if (!wallet) continue

        const entries = await prisma.pointLedgerEntry.findMany({
          where: {
            walletId,
            createdAt: { gte: windowStart, lte: windowEnd },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            direction: true,
            txType: true,
            amount: true,
            balanceAfter: true,
            idempotencyKey: true,
            metadata: true,
            description: true,
            createdAt: true,
          },
        })
        if (entries.length === 0) continue

        const first = entries[0]!
        const prior = await prisma.pointLedgerEntry.findFirst({
          where: {
            walletId,
            OR: [
              { createdAt: { lt: first.createdAt } },
              { createdAt: first.createdAt, id: { lt: first.id } },
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, balanceAfter: true },
        })

        let balanceBefore = prior?.balanceAfter ?? 0n
        let priorEntryId: string | null = prior?.id ?? null
        const user = userMap.get(wallet.userId)

        for (const entry of entries) {
          checked += 1
          const carries = pointLedgerBalanceCarriesForward(entry.txType)
          const check = checkLedgerBalanceChain({
            balanceBefore,
            direction: entry.direction,
            amount: entry.amount,
            balanceAfter: entry.balanceAfter,
            balanceCarriesForward: carries,
          })
          if (!check.ok) {
            drafts.push({
              userId: wallet.userId,
              category: 'POINT',
              code: LEDGER_AUDIT_CODES.LEDGER_BALANCE_CHAIN_BREAK,
              severity: 'CRITICAL',
              fingerprint: `${LEDGER_AUDIT_CODES.LEDGER_BALANCE_CHAIN_BREAK}:${entry.id}`,
              summary: 'Points ledger balanceAfter does not match prior balance ± amount',
              evidence: {
                ...(user ? userSnapshot(user) : { userId: wallet.userId }),
                currencyType: 'POINT',
                pointLedgerEntryId: entry.id,
                priorLedgerEntryId: priorEntryId,
                txType: entry.txType,
                direction: entry.direction,
                amount: entry.amount.toString(),
                balanceBefore: check.balanceBefore.toString(),
                expectedBalanceAfter: check.expectedBalanceAfter.toString(),
                actualBalanceAfter: check.actualBalanceAfter.toString(),
                balanceCarriesForward: check.balanceCarriesForward,
                idempotencyKey: entry.idempotencyKey,
                metadata: entry.metadata,
                description: entry.description,
                createdAt: entry.createdAt.toISOString(),
              },
              pointLedgerEntryId: entry.id,
              windowStart,
              windowEnd,
            })
          }
          balanceBefore = entry.balanceAfter
          priorEntryId = entry.id
        }
      }
    }

    return checked
  },

  async scanVipEntitlements(
    windowStart: Date,
    windowEnd: Date,
    dayKey: string,
    drafts: LedgerAuditFlagDraft[],
  ): Promise<number> {
    let checked = 0
    const now = windowEnd

    // Purchases in window → verify ledger linkage
    let purchaseSkip = 0
    for (;;) {
      const purchases = await prisma.vipMembershipPurchase.findMany({
        where: { createdAt: { gte: windowStart, lte: windowEnd } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: purchaseSkip,
        take: PAGE,
        include: {
          ledgerEntry: {
            include: { wallet: { select: { userId: true, currencyType: true } } },
          },
          user: {
            select: {
              id: true,
              username: true,
              publicId: true,
              currentVipPublicId: true,
              firstName: true,
              lastName: true,
              vipSubscriptionActive: true,
              vipSubscriptionExpiresAt: true,
            },
          },
        },
      })
      if (purchases.length === 0) break
      purchaseSkip += purchases.length

      for (const p of purchases) {
        const ledger = p.ledgerEntry
        const bad =
          !ledger ||
          ledger.wallet.userId !== p.userId ||
          ledger.wallet.currencyType !== WalletCurrencyType.COIN ||
          ledger.txType !== CoinTxType.VIP_MEMBERSHIP_PURCHASE ||
          ledger.direction !== LedgerDirection.DEBIT ||
          ledger.amount !== p.coinCost

        if (bad) {
          drafts.push({
            userId: p.userId,
            category: 'VIP',
            code: LEDGER_AUDIT_CODES.VIP_PURCHASE_WITHOUT_LEDGER,
            severity: 'CRITICAL',
            fingerprint: `${LEDGER_AUDIT_CODES.VIP_PURCHASE_WITHOUT_LEDGER}:${p.id}`,
            summary: 'VIP membership purchase row missing or mismatched coin ledger debit',
            evidence: {
              ...userSnapshot(p.user),
              vipPurchaseId: p.id,
              tier: p.tier,
              periodDays: p.periodDays,
              coinCost: p.coinCost.toString(),
              ledgerEntryId: p.ledgerEntryId,
              ledger: ledger
                ? {
                    id: ledger.id,
                    walletUserId: ledger.wallet.userId,
                    currencyType: ledger.wallet.currencyType,
                    txType: ledger.txType,
                    direction: ledger.direction,
                    amount: ledger.amount.toString(),
                  }
                : null,
              createdAt: p.createdAt.toISOString(),
            },
            vipPurchaseId: p.id,
            ledgerEntryId: p.ledgerEntryId,
            windowStart,
            windowEnd,
          })
        }
      }
      if (purchases.length < PAGE) break
    }

    // Active VIP users: reconstruct expiry from full purchase history
    let userCursor: string | undefined
    for (;;) {
      const users = await prisma.user.findMany({
        where: {
          OR: [{ vipSubscriptionActive: true }, { vipSubscriptionExpiresAt: { gt: now } }],
          ...(userCursor ? { id: { gt: userCursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: VIP_USER_PAGE,
        select: {
          id: true,
          username: true,
          publicId: true,
          currentVipPublicId: true,
          firstName: true,
          lastName: true,
          vipSubscriptionActive: true,
          vipSubscriptionExpiresAt: true,
        },
      })
      if (users.length === 0) break
      userCursor = users[users.length - 1]!.id
      checked += users.length

      const purchaseRows = await prisma.vipMembershipPurchase.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          userId: true,
          createdAt: true,
          periodDays: true,
          expiresAtAfter: true,
          coinCost: true,
          ledgerEntryId: true,
        },
      })
      const byUser = new Map<string, VipPurchaseReplayRow[]>()
      for (const p of purchaseRows) {
        const list = byUser.get(p.userId) ?? []
        list.push(p)
        byUser.set(p.userId, list)
      }

      for (const u of users) {
        const purchases = byUser.get(u.id) ?? []
        const isActive =
          (u.vipSubscriptionExpiresAt != null &&
            u.vipSubscriptionExpiresAt.getTime() > now.getTime()) ||
          u.vipSubscriptionActive

        if (isActive && purchases.length === 0) {
          drafts.push({
            userId: u.id,
            category: 'VIP',
            code: LEDGER_AUDIT_CODES.VIP_ACTIVE_WITHOUT_PURCHASE,
            severity: 'CRITICAL',
            fingerprint: `${LEDGER_AUDIT_CODES.VIP_ACTIVE_WITHOUT_PURCHASE}:${u.id}:${dayKey}`,
            summary: 'Active VIP membership with zero purchase history rows',
            evidence: {
              ...userSnapshot(u),
              purchaseCount: 0,
            },
            windowStart,
            windowEnd,
          })
          continue
        }

        const expected = reconstructVipExpiresAt(purchases)
        if (vipExpiresDisagree(u.vipSubscriptionExpiresAt, expected)) {
          drafts.push({
            userId: u.id,
            category: 'VIP',
            code: LEDGER_AUDIT_CODES.VIP_EXPIRY_MISMATCH,
            severity: 'WARNING',
            fingerprint: `${LEDGER_AUDIT_CODES.VIP_EXPIRY_MISMATCH}:${u.id}:${dayKey}`,
            summary: 'VIP subscription expiry does not match reconstructed purchase stack',
            evidence: {
              ...userSnapshot(u),
              expectedExpiresAt: expected?.toISOString() ?? null,
              actualExpiresAt: u.vipSubscriptionExpiresAt?.toISOString() ?? null,
              purchaseCount: purchases.length,
              purchases: purchases.map((p) => ({
                id: p.id,
                createdAt: p.createdAt.toISOString(),
                periodDays: p.periodDays,
                coinCost: p.coinCost.toString(),
                expiresAtAfter: p.expiresAtAfter.toISOString(),
                ledgerEntryId: p.ledgerEntryId,
              })),
            },
            windowStart,
            windowEnd,
          })
        }
      }

      if (users.length < VIP_USER_PAGE) break
    }

    return checked
  },

  serializeFlag(flag: {
    id: string
    userId: string
    category: string
    code: string
    severity: string
    status: string
    fingerprint: string
    summary: string
    evidence: Prisma.JsonValue
    ledgerEntryId: string | null
    pointLedgerEntryId: string | null
    vipPurchaseId: string | null
    windowStart: Date
    windowEnd: Date
    resolvedAt: Date | null
    resolvedByAdminId: string | null
    resolutionNote: string | null
    createdAt: Date
    updatedAt: Date
    user?: {
      id: string
      username: string
      publicId: bigint
      currentVipPublicId: bigint | null
      firstName: string | null
      lastName: string | null
    }
  }) {
    return {
      id: flag.id,
      userId: flag.userId,
      category: flag.category,
      code: flag.code,
      severity: flag.severity,
      status: flag.status,
      fingerprint: flag.fingerprint,
      summary: flag.summary,
      evidence: flag.evidence,
      ledgerEntryId: flag.ledgerEntryId,
      pointLedgerEntryId: flag.pointLedgerEntryId,
      vipPurchaseId: flag.vipPurchaseId,
      windowStart: flag.windowStart.toISOString(),
      windowEnd: flag.windowEnd.toISOString(),
      resolvedAt: flag.resolvedAt?.toISOString() ?? null,
      resolvedByAdminId: flag.resolvedByAdminId,
      resolutionNote: flag.resolutionNote,
      createdAt: flag.createdAt.toISOString(),
      updatedAt: flag.updatedAt.toISOString(),
      user: flag.user
        ? {
            id: flag.user.id,
            username: flag.user.username,
            publicId: flag.user.publicId.toString(),
            currentVipPublicId: flag.user.currentVipPublicId?.toString() ?? null,
            firstName: flag.user.firstName,
            lastName: flag.user.lastName,
            name: formatUserName(flag.user),
            displayId: (flag.user.currentVipPublicId ?? flag.user.publicId).toString(),
          }
        : undefined,
    }
  },
}
