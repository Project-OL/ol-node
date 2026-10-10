import type { CreatorSubscription, Prisma } from '@prisma/client'
import { CreatorSubscriptionStatus } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { USER_STATUSES } from '../models/types'
import { countryEqualsFilter } from '../utils/agency-country'
import type { SubscriptionCursor } from '../utils/subscriptionCursor'

const BLOCKED_USER_STATUSES = [
  'suspended',
  'deleted',
] as const satisfies readonly (typeof USER_STATUSES)[number][]

const topCreatorBySubscriberWhere = {
  status: { notIn: [...BLOCKED_USER_STATUSES] },
  creatorSubsAsHost: { some: { status: CreatorSubscriptionStatus.ACTIVE } },
} satisfies Prisma.UserWhereInput

const topCreatorBySubscriberSelect = {
  id: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  _count: {
    select: {
      creatorSubsAsHost: {
        where: { status: CreatorSubscriptionStatus.ACTIVE },
      },
    },
  },
} as const

export type TopCreatorQueryRow = Prisma.UserGetPayload<{
  select: typeof topCreatorBySubscriberSelect
}>

/**
 * Who can see a creator's subscriber content right now: ACTIVE (renewing), or CANCELLED
 * but still inside the period already paid for. GRACE/EXPIRED never have access.
 * Lists, counts and leaderboards keep using ACTIVE only (they mean "renewing subscribers").
 */
function paidAccessWhere(): Prisma.CreatorSubscriptionWhereInput {
  return {
    OR: [
      { status: CreatorSubscriptionStatus.ACTIVE },
      { status: CreatorSubscriptionStatus.CANCELLED, nextRenewalAt: { gt: new Date() } },
    ],
  }
}

const userListSelect = {
  id: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  country: true,
} as const

export const subscriptionRepository = {
  async findByPair(subscriberId: string, creatorId: string): Promise<CreatorSubscription | null> {
    return prismaRead.creatorSubscription.findUnique({
      where: {
        subscriberId_creatorId: { subscriberId, creatorId },
      },
    })
  },

  async findById(id: string): Promise<CreatorSubscription | null> {
    return prismaRead.creatorSubscription.findUnique({ where: { id } })
  },

  async countActiveByCreatorId(creatorId: string): Promise<number> {
    return prismaRead.creatorSubscription.count({
      where: { creatorId, status: CreatorSubscriptionStatus.ACTIVE },
    })
  },

  /** Creators whose content the subscriber can currently see (see `paidAccessWhere`). */
  async getActiveSubscriptions(subscriberId: string): Promise<{ creatorId: string }[]> {
    return prismaRead.creatorSubscription.findMany({
      where: { subscriberId, ...paidAccessWhere() },
      select: { creatorId: true },
    })
  },

  /** How many creators the subscriber can currently see (see `paidAccessWhere`). */
  async countPaidAccess(subscriberId: string): Promise<number> {
    return prismaRead.creatorSubscription.count({
      where: { subscriberId, ...paidAccessWhere() },
    })
  },

  /** Pairs with current paid access (see `paidAccessWhere`), for the access-check DB fallback. */
  async findActivePairs(
    subscriberId: string,
    creatorIds: string[],
  ): Promise<Array<{ creatorId: string; nextRenewalAt: Date }>> {
    if (creatorIds.length === 0) return []
    return prismaRead.creatorSubscription.findMany({
      where: {
        subscriberId,
        creatorId: { in: creatorIds },
        ...paidAccessWhere(),
      },
      select: { creatorId: true, nextRenewalAt: true },
    })
  },

  /** True while the subscriber has paid access (see `paidAccessWhere`). */
  async isActivePair(subscriberId: string, creatorId: string): Promise<boolean> {
    const count = await prismaRead.creatorSubscription.count({
      where: {
        subscriberId,
        creatorId,
        ...paidAccessWhere(),
      },
    })
    return count > 0
  },

  /** CANCELLED → ACTIVE without touching `nextRenewalAt`; null if it isn't (still) resumable. */
  async resumeCancelledWithinPeriod(id: string): Promise<CreatorSubscription | null> {
    const { count } = await prisma.creatorSubscription.updateMany({
      where: {
        id,
        status: CreatorSubscriptionStatus.CANCELLED,
        nextRenewalAt: { gt: new Date() },
      },
      data: { status: CreatorSubscriptionStatus.ACTIVE, graceUntil: null },
    })
    if (count === 0) return null
    return prisma.creatorSubscription.findUnique({ where: { id } })
  },

  async listActiveCreatorsForSubscriber(
    subscriberId: string,
    limit: number,
    cursor?: SubscriptionCursor,
  ) {
    return prismaRead.creatorSubscription.findMany({
      where: {
        subscriberId,
        status: CreatorSubscriptionStatus.ACTIVE,
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: new Date(cursor.updatedAt) } },
                {
                  updatedAt: new Date(cursor.updatedAt),
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        creator: { select: userListSelect },
      },
    })
  },

  async listActiveSubscribersForCreator(
    creatorId: string,
    limit: number,
    cursor?: SubscriptionCursor,
  ) {
    return prismaRead.creatorSubscription.findMany({
      where: {
        creatorId,
        status: CreatorSubscriptionStatus.ACTIVE,
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: new Date(cursor.updatedAt) } },
                {
                  updatedAt: new Date(cursor.updatedAt),
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        subscriber: { select: userListSelect },
      },
    })
  },

  async upsertActiveInTx(
    tx: Prisma.TransactionClient,
    params: {
      subscriberId: string
      creatorId: string
      nextRenewalAt: Date
    },
  ): Promise<CreatorSubscription> {
    return tx.creatorSubscription.upsert({
      where: {
        subscriberId_creatorId: {
          subscriberId: params.subscriberId,
          creatorId: params.creatorId,
        },
      },
      create: {
        subscriberId: params.subscriberId,
        creatorId: params.creatorId,
        status: CreatorSubscriptionStatus.ACTIVE,
        nextRenewalAt: params.nextRenewalAt,
        graceUntil: null,
      },
      update: {
        status: CreatorSubscriptionStatus.ACTIVE,
        nextRenewalAt: params.nextRenewalAt,
        graceUntil: null,
      },
    })
  },

  async updateById(
    id: string,
    data: Prisma.CreatorSubscriptionUpdateInput,
  ): Promise<CreatorSubscription> {
    return prisma.creatorSubscription.update({
      where: { id },
      data,
    })
  },

  async queryTopCreatorsByCountry(country: string, limit: number): Promise<TopCreatorQueryRow[]> {
    return prismaRead.user.findMany({
      where: {
        country: countryEqualsFilter(country),
        ...topCreatorBySubscriberWhere,
      },
      select: topCreatorBySubscriberSelect,
      orderBy: {
        creatorSubsAsHost: { _count: 'desc' },
      },
      take: limit,
    })
  },

  async queryTopCreatorsGlobal(limit: number): Promise<TopCreatorQueryRow[]> {
    return prismaRead.user.findMany({
      where: topCreatorBySubscriberWhere,
      select: topCreatorBySubscriberSelect,
      orderBy: {
        creatorSubsAsHost: { _count: 'desc' },
      },
      take: limit,
    })
  },

  async queryTopCreatorsByPostCount(limit: number): Promise<TopCreatorQueryRow[]> {
    return prismaRead.user.findMany({
      where: {
        status: { notIn: [...BLOCKED_USER_STATUSES] },
        posts: { some: {} },
      },
      select: topCreatorBySubscriberSelect,
      orderBy: {
        posts: { _count: 'desc' },
      },
      take: limit,
    })
  },

  async updateByIdInTx(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.CreatorSubscriptionUpdateInput,
  ): Promise<CreatorSubscription> {
    return tx.creatorSubscription.update({
      where: { id },
      data,
    })
  },
}
