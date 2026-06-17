import type { CreatorSubscription, Prisma } from '@prisma/client'
import { CreatorSubscriptionStatus } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { USER_STATUSES } from '../models/types'

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

  async getActiveSubscriptions(subscriberId: string): Promise<{ creatorId: string }[]> {
    return prismaRead.creatorSubscription.findMany({
      where: { subscriberId, status: CreatorSubscriptionStatus.ACTIVE },
      select: { creatorId: true },
    })
  },

  async isActivePair(subscriberId: string, creatorId: string): Promise<boolean> {
    const count = await prismaRead.creatorSubscription.count({
      where: {
        subscriberId,
        creatorId,
        status: CreatorSubscriptionStatus.ACTIVE,
      },
    })
    return count > 0
  },

  async listActiveCreatorsForSubscriber(subscriberId: string) {
    return prismaRead.creatorSubscription.findMany({
      where: {
        subscriberId,
        status: CreatorSubscriptionStatus.ACTIVE,
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        creator: { select: userListSelect },
      },
    })
  },

  async listActiveSubscribersForCreator(creatorId: string) {
    return prismaRead.creatorSubscription.findMany({
      where: {
        creatorId,
        status: CreatorSubscriptionStatus.ACTIVE,
      },
      orderBy: { updatedAt: 'desc' },
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
        country,
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
