import { AGENCY_RANKING_CACHE_TTL, RedisKeys, redisClient } from '../config/redis'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { agencyRepository } from '../repositories/agency.repository'
import { agencyCoinsellerRepository } from '../repositories/agencyCoinseller.repository'
import { agencyCoinsellerService } from './agencyCoinseller.service'
import { walletLevelService } from './user-level.service'
import { formatUserName } from '../utils/user-display'
import { countryCacheKeySegment } from '../utils/agency-country'

export type AgencyRankingPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ALL_TIME'

export type AgencyPublicProfile = {
  agencyPublicId: string
  agencyUserId: string
  userId: string
  publicId: string | null
  displayPublicId: string
  gender: string | null
  age: number | null
  wealthLevel: number
  livestreamLevel: number
  agencyContactNumber: string | null
  priceImageUrl: string | null
  whatsappNumber: string | null
  transferChannel: string
  /** Agency owner `users.avatar_url` (CDN URL or null). */
  avatarUrl: string | null
  displayName: string
  /** Agency owner first + last (strict); empty if both missing. No owner → agency displayName. */
  name: string
  totalHostsCount: number
  lifetimeHostEarningsPoints: string
  currentLevel: string
  paused: boolean
}

export type AgencyRankingItem = AgencyPublicProfile & {
  rank: number
}

function encodeCursor(skip: number): string {
  return Buffer.from(JSON.stringify({ skip }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as { skip?: number }
    return typeof parsed.skip === 'number' && parsed.skip >= 0 ? parsed.skip : 0
  } catch {
    return 0
  }
}

function computeAgeFromDob(dob: Date | null | undefined): number | null {
  if (dob == null) return null
  const today = new Date()
  let years = today.getFullYear() - dob.getFullYear()
  const m = today.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
    years--
  }
  return years >= 0 ? years : null
}

type AgencyRowForProfile = {
  userId: string
  defaultPublicId: bigint
  displayName: string
  totalHostsCount: number
  lifetimeHostEarningsPoints: bigint
  currentLevel: string
  pausedAt: Date | null
}

type OwnerUserForProfile = {
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  username: string
  firstName: string | null
  lastName: string | null
  gender: string | null
  dateOfBirth: Date | null
  avatarUrl: string | null
} | null

type CoinsellerForProfile = {
  priceImageS3Key: string | null
  whatsappNumber: string | null
  transferChannel: string
} | null

export function mapAgencyToPublicProfile(params: {
  agency: AgencyRowForProfile
  owner: OwnerUserForProfile
  wealthLevel: number
  livestreamLevel: number
  agencyContactNumber: string | null
  coinseller?: CoinsellerForProfile
}): AgencyPublicProfile {
  const { agency, owner } = params
  const displayPublicId = owner
    ? String(owner.currentVipPublicId ?? owner.defaultPublicId ?? owner.publicId)
    : agency.defaultPublicId.toString()
  return {
    agencyPublicId: agency.defaultPublicId.toString(),
    agencyUserId: agency.userId,
    userId: agency.userId,
    publicId: owner ? String(owner.publicId) : null,
    displayPublicId,
    gender: owner?.gender ?? null,
    age: computeAgeFromDob(owner?.dateOfBirth ?? null),
    wealthLevel: params.wealthLevel,
    livestreamLevel: params.livestreamLevel,
    agencyContactNumber: params.agencyContactNumber,
    priceImageUrl: agencyCoinsellerService.getPriceImageUrl(
      params.coinseller?.priceImageS3Key ?? null,
    ),
    whatsappNumber: params.coinseller?.whatsappNumber ?? null,
    transferChannel: params.coinseller?.transferChannel ?? 'EPAY',
    avatarUrl: owner?.avatarUrl ?? null,
    displayName: agency.displayName,
    name: owner ? formatUserName(owner) : agency.displayName,
    totalHostsCount: agency.totalHostsCount,
    lifetimeHostEarningsPoints: agency.lifetimeHostEarningsPoints.toString(),
    currentLevel: agency.currentLevel,
    paused: agency.pausedAt != null,
  }
}

export const agencyRankingService = {
  /** Full agency card by agency owner user id (same shape as ranking items, without `rank`). */
  async getPublicByUserId(agencyUserId: string): Promise<AgencyPublicProfile | null> {
    const agency = await agencyRepository.getAgencyByUserId(agencyUserId)
    if (!agency) return null

    const [levelsMap, owner, kyc, coinsellerRows] = await Promise.all([
      walletLevelService.getDisplayLevelsForUsers([agency.userId]),
      prismaRead.user.findUnique({
        where: { id: agency.userId },
        select: {
          publicId: true,
          defaultPublicId: true,
          currentVipPublicId: true,
          username: true,
          firstName: true,
          lastName: true,
          gender: true,
          dateOfBirth: true,
          avatarUrl: true,
        },
      }),
      prismaRead.agencyApplicationKyc.findUnique({
        where: { userId: agency.userId },
        select: { contactPhone: true },
      }),
      agencyCoinsellerRepository.findManyByAgencyUserIds([agency.userId]),
    ])

    const coinseller = coinsellerRows[0] ?? null
    const lv = levelsMap.get(agency.userId)
    return mapAgencyToPublicProfile({
      agency,
      owner,
      wealthLevel: lv?.wealthLevel ?? 0,
      livestreamLevel: lv?.livestreamLevel ?? 0,
      agencyContactNumber: kyc?.contactPhone ?? null,
      coinseller: coinseller
        ? {
            priceImageS3Key: coinseller.priceImageS3Key,
            whatsappNumber: coinseller.whatsappNumber,
            transferChannel: coinseller.transferChannel,
          }
        : null,
    })
  },

  /** Full agency card by canonical or display public id (same shape as ranking items, without `rank`). */
  async getAgencyPublicProfile(publicIdString: string): Promise<AgencyPublicProfile | null> {
    let pid: bigint
    try {
      pid = BigInt(publicIdString.trim())
    } catch {
      throw new AppError(400, 'Invalid agency public id', 'INVALID_AGENCY_ID')
    }

    const agency = await agencyRepository.getAgencyByPublicId(pid)
    if (!agency) return null

    const [levelsMap, owner, kyc, coinsellerRows] = await Promise.all([
      walletLevelService.getDisplayLevelsForUsers([agency.userId]),
      prismaRead.user.findUnique({
        where: { id: agency.userId },
        select: {
          publicId: true,
          defaultPublicId: true,
          currentVipPublicId: true,
          username: true,
          firstName: true,
          lastName: true,
          gender: true,
          dateOfBirth: true,
          avatarUrl: true,
        },
      }),
      prismaRead.agencyApplicationKyc.findUnique({
        where: { userId: agency.userId },
        select: { contactPhone: true },
      }),
      agencyCoinsellerRepository.findManyByAgencyUserIds([agency.userId]),
    ])

    const coinseller = coinsellerRows[0] ?? null
    const lv = levelsMap.get(agency.userId)
    return mapAgencyToPublicProfile({
      agency,
      owner,
      wealthLevel: lv?.wealthLevel ?? 0,
      livestreamLevel: lv?.livestreamLevel ?? 0,
      agencyContactNumber: kyc?.contactPhone ?? null,
      coinseller: coinseller
        ? {
            priceImageS3Key: coinseller.priceImageS3Key,
            whatsappNumber: coinseller.whatsappNumber,
            transferChannel: coinseller.transferChannel,
          }
        : null,
    })
  },
  /**
   * Phase 1 discovery: sorted by `totalHostsCount` DESC for every period (placeholder).
   * Prefer earnings-based `GET /api/v1/rankings/agency` (see platform-rankings-flow.md).
   */
  async getRanking(params: {
    period: AgencyRankingPeriod
    limit: number
    cursor?: string | null
    country: string | null
  }) {
    const limit = Math.min(Math.max(params.limit, 1), 100)
    const skip = decodeCursor(params.cursor ?? undefined)
    const countryKey = params.country ? countryCacheKeySegment(params.country) : 'none'
    const cacheKey = RedisKeys.agencyRanking(countryKey, params.period, limit, params.cursor ?? '')

    if (!params.country) {
      return {
        period: params.period,
        items: [] as AgencyRankingItem[],
        nextCursor: null,
      }
    }
    try {
      const cached = await redisClient.get(cacheKey)
      if (cached) {
        return JSON.parse(cached) as {
          period: AgencyRankingPeriod
          items: AgencyRankingItem[]
          nextCursor: string | null
        }
      }
    } catch {
      /* fall through */
    }

    const rows = await agencyRepository.listForRanking({
      limit,
      skip,
      country: params.country,
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore && page.length > 0 ? encodeCursor(skip + limit) : null

    let items: AgencyRankingItem[] = []
    if (page.length > 0) {
      const userIds = page.map((r) => r.userId)
      const [levelsMap, users, kycRows, coinsellerRows] = await Promise.all([
        walletLevelService.getDisplayLevelsForUsers(userIds),
        prismaRead.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            username: true,
            firstName: true,
            lastName: true,
            gender: true,
            dateOfBirth: true,
            avatarUrl: true,
          },
        }),
        prismaRead.agencyApplicationKyc.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, contactPhone: true },
        }),
        agencyCoinsellerRepository.findManyByAgencyUserIds(userIds),
      ])
      const userById = new Map(users.map((u) => [u.id, u]))
      const phoneByUserId = new Map(kycRows.map((k) => [k.userId, k.contactPhone]))
      const coinsellerByUserId = new Map(coinsellerRows.map((c) => [c.agencyUserId, c]))
      items = page.map((r, i) => {
        const cs = coinsellerByUserId.get(r.userId)
        return {
          rank: skip + i + 1,
          ...mapAgencyToPublicProfile({
            agency: r,
            owner: userById.get(r.userId) ?? null,
            wealthLevel: levelsMap.get(r.userId)?.wealthLevel ?? 0,
            livestreamLevel: levelsMap.get(r.userId)?.livestreamLevel ?? 0,
            agencyContactNumber: phoneByUserId.get(r.userId) ?? null,
            coinseller: cs
              ? {
                  priceImageS3Key: cs.priceImageS3Key,
                  whatsappNumber: cs.whatsappNumber,
                  transferChannel: cs.transferChannel,
                }
              : null,
          }),
        }
      })
    }

    const payload = {
      period: params.period,
      items,
      nextCursor,
    }

    try {
      await redisClient.set(cacheKey, JSON.stringify(payload), 'EX', AGENCY_RANKING_CACHE_TTL)
    } catch {
      /* ignore */
    }

    return payload
  },
}
