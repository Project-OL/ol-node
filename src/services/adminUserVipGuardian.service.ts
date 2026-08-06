import { CoinTxType, LedgerDirection, WalletCurrencyType } from '@prisma/client'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import {
  guardianRepository,
  type GuardianUserCard,
} from '../repositories/guardian.repository'
import { vipMembershipRepository } from '../repositories/vipMembership.repository'
import { vipMembershipService } from './vip-membership.service'
import { richTierService } from './rich-tier.service'
import { walletLevelService } from './user-level.service'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'

function daysRemainingFor(expiresAt: Date, now = new Date()): number {
  if (expiresAt.getTime() <= now.getTime()) return 0
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000))
}

function computeAge(dob: Date | null): number | null {
  if (!dob) return null
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const m = today.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
    age--
  }
  return age >= 0 ? age : null
}

function mapCounterparty(u: GuardianUserCard, levels?: { livestreamLevel: number; wealthLevel: number }) {
  const displayName = buildUserDisplayName(u)
  return {
    userId: u.id,
    username: u.username,
    displayName,
    name: displayName,
    avatarUrl: u.avatarUrl,
    publicId: u.publicId.toString(),
    displayPublicId: resolveDisplayPublicId(u),
    country: u.country,
    gender: u.gender,
    age: computeAge(u.dateOfBirth),
    livestreamLevel: levels?.livestreamLevel ?? 0,
    wealthLevel: levels?.wealthLevel ?? 0,
  }
}

async function assertUserExists(userId: string) {
  const user = await prismaRead.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
}

export const adminUserVipGuardianService = {
  async getUserVipDetail(
    userId: string,
    opts?: {
      purchasesLimit?: number
      purchasesCursor?: string | null
      claimsLimit?: number
      claimsCursor?: string | null
    },
  ) {
    await assertUserExists(userId)

    const purchasesLimit = Math.min(Math.max(opts?.purchasesLimit ?? 50, 1), 100)
    const claimsLimit = Math.min(Math.max(opts?.claimsLimit ?? 50, 1), 100)

    const [row, membership, richTier, purchasesPage, claimsPage, purchaseCount, claimCount, config] =
      await Promise.all([
        vipMembershipRepository.getMembershipRow(userId),
        vipMembershipService.buildMeVipMembershipBlock(userId),
        richTierService.getRichTierCardFields(userId),
        vipMembershipService.getPurchaseHistory(userId, {
          limit: purchasesLimit,
          cursor: opts?.purchasesCursor,
        }),
        vipMembershipRepository.getDailyClaimHistory(userId, {
          limit: claimsLimit,
          cursorClaimDate: opts?.claimsCursor,
        }),
        vipMembershipRepository.countPurchases(userId),
        vipMembershipRepository.countDailyClaims(userId),
        Promise.resolve(vipMembershipService.getPublicConfig()),
      ])

    if (!row) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const now = new Date()
    const rareIdActive =
      row.currentVipPublicId != null &&
      (row.vipPublicIdExpiresAt == null || row.vipPublicIdExpiresAt > now)

    return {
      userId,
      membership: {
        isActive: membership.isActive,
        tier: membership.tier ?? null,
        expiresAt: membership.expiresAt ?? null,
        daysRemaining: membership.daysRemaining,
        subscriptionActive: row.vipSubscriptionActive,
        subscriptionStartAt: row.vipSubscriptionStartAt?.toISOString() ?? null,
        subscriptionExpiresAt: row.vipSubscriptionExpiresAt?.toISOString() ?? null,
        dailyClaimAvailable: membership.dailyClaimAvailable,
        lastClaimedAt: membership.lastClaimedAt ?? null,
        privileges: {
          vipExclusiveProfileCard: membership.vipExclusiveProfileCard,
          vipDistinguishedLogo: membership.vipDistinguishedLogo,
          vipExclusiveMessageBackground: membership.vipExclusiveMessageBackground,
          vipSpecialEntryEffect: membership.vipSpecialEntryEffect,
          vipPreventBeingKicked: membership.vipPreventBeingKicked,
          vipLiveTranslationEnabled: membership.vipLiveTranslationEnabled,
        },
      },
      rareId: {
        currentVipPublicId: row.currentVipPublicId?.toString() ?? null,
        vipPublicIdExpiresAt: row.vipPublicIdExpiresAt?.toISOString() ?? null,
        active: rareIdActive,
      },
      richTier: {
        tier: richTier.tier,
        displayName: richTier.displayName,
      },
      config,
      purchases: {
        total: purchaseCount,
        ...purchasesPage,
      },
      dailyClaims: {
        total: claimCount,
        items: claimsPage.items.map((c) => ({
          claimDate: c.claimDate.toISOString().slice(0, 10),
          coinAmount: c.coinAmount.toString(),
          ledgerEntryId: c.ledgerEntryId,
          claimedAt: c.claimedAt.toISOString(),
        })),
        nextCursor: claimsPage.nextCursor ?? null,
        hasMore: claimsPage.hasMore,
      },
    }
  },

  async getUserGuardians(
    userId: string,
    opts?: { purchaseHistoryLimit?: number },
  ) {
    await assertUserExists(userId)

    const purchaseHistoryLimit = Math.min(Math.max(opts?.purchaseHistoryLimit ?? 50, 1), 100)

    const [asGuardianRows, asTargetRows, purchaseLedger] = await Promise.all([
      guardianRepository.findAllAsGuardian(userId),
      guardianRepository.findAllAsTarget(userId),
      prismaRead.coinLedgerEntry.findMany({
        where: {
          txType: CoinTxType.GUARDIAN_PURCHASE,
          direction: LedgerDirection.DEBIT,
          wallet: {
            userId,
            currencyType: WalletCurrencyType.COIN,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: purchaseHistoryLimit,
        select: {
          id: true,
          amount: true,
          counterpartyId: true,
          metadata: true,
          description: true,
          createdAt: true,
          idempotencyKey: true,
        },
      }),
    ])

    const counterpartyIds = new Set<string>()
    for (const r of asGuardianRows) counterpartyIds.add(r.targetUserId)
    for (const r of asTargetRows) counterpartyIds.add(r.guardianUserId)
    for (const e of purchaseLedger) {
      if (e.counterpartyId) counterpartyIds.add(e.counterpartyId)
    }

    const levels = await walletLevelService.getDisplayLevelsForUsers([...counterpartyIds])
    const now = new Date()

    const mapRel = (
      role: 'guardian' | 'target',
      row: (typeof asGuardianRows)[number] | (typeof asTargetRows)[number],
      related: GuardianUserCard,
    ) => {
      const active = !row.isExpired && row.expiresAt.getTime() > now.getTime()
      return {
        guardianId: row.id,
        role,
        tier: row.tier,
        durationMonths: row.durationMonths,
        coinsPaid: row.coinsPaid.toString(),
        purchasedAt: row.purchasedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        daysRemaining: daysRemainingFor(row.expiresAt, now),
        isExpired: !active,
        isTopGuardian: false as boolean,
        counterparty: mapCounterparty(related, levels.get(related.id)),
      }
    }

    const asGuardian = asGuardianRows.map((r) =>
      mapRel('guardian', r, r.targetUser),
    )
    const asTarget = asTargetRows.map((r) => mapRel('target', r, r.guardianUser))

    // Mark top guardian among active targets of this user.
    const activeTargets = asTarget.filter((r) => !r.isExpired)
    if (activeTargets.length > 0) {
      const tierRank: Record<string, number> = { SILVER: 1, GOLD: 2, KING: 3 }
      const top = [...activeTargets].sort((a, b) => {
        const tr = (tierRank[b.tier] ?? 0) - (tierRank[a.tier] ?? 0)
        if (tr !== 0) return tr
        return new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime()
      })[0]
      if (top) {
        const hit = asTarget.find((r) => r.guardianId === top.guardianId)
        if (hit) hit.isTopGuardian = true
      }
    }

    // Enrich purchase ledger counterparties (targets of purchases made by this user).
    const ledgerCounterpartyIds = [
      ...new Set(purchaseLedger.map((e) => e.counterpartyId).filter((id): id is string => !!id)),
    ]
    const ledgerUsers =
      ledgerCounterpartyIds.length > 0
        ? await prismaRead.user.findMany({
            where: { id: { in: ledgerCounterpartyIds } },
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
              publicId: true,
              defaultPublicId: true,
              currentVipPublicId: true,
              country: true,
              gender: true,
              dateOfBirth: true,
            },
          })
        : []
    const ledgerUserById = new Map(ledgerUsers.map((u) => [u.id, u]))

    const purchases = purchaseLedger.map((e) => {
      const meta = (e.metadata ?? {}) as Record<string, unknown>
      const targetId =
        e.counterpartyId ??
        (typeof meta.targetUserId === 'string' ? meta.targetUserId : null)
      const related = targetId ? ledgerUserById.get(targetId) : undefined
      // Current relationship (if still present after upsert) for type/duration.
      const current = asGuardian.find((r) => r.counterparty.userId === targetId)
      return {
        ledgerEntryId: e.id,
        purchasedAt: e.createdAt.toISOString(),
        coinsPaid: e.amount.toString(),
        description: e.description,
        idempotencyKey: e.idempotencyKey,
        /** Current relationship tier when still present; null if relationship expired/removed from upsert table without match. */
        tier: current?.tier ?? null,
        durationMonths: current?.durationMonths ?? null,
        counterparty: related
          ? mapCounterparty(related, levels.get(related.id) ?? undefined)
          : targetId
            ? {
                userId: targetId,
                username: null,
                displayName: null,
                name: null,
                avatarUrl: null,
                publicId: null,
                displayPublicId: null,
                country: null,
                gender: null,
                age: null,
                livestreamLevel: 0,
                wealthLevel: 0,
              }
            : null,
      }
    })

    return {
      userId,
      asGuardian,
      asTarget,
      /**
       * Coin-ledger GUARDIAN_PURCHASE debits by this user (true purchase history).
       * Guardians table upserts per (guardian, target) pair, so `asGuardian` is current state only.
       */
      purchases,
      summary: {
        asGuardianCount: asGuardian.length,
        asTargetCount: asTarget.length,
        activeAsGuardianCount: asGuardian.filter((r) => !r.isExpired).length,
        activeAsTargetCount: asTarget.filter((r) => !r.isExpired).length,
        purchaseHistoryCount: purchases.length,
      },
    }
  },
}
