import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type CreateLocationSampleInput = {
  userId: string
  latitude: number
  longitude: number
  accuracyM?: number | null
  source?: string
  recordedAt?: Date
}

export const userLocationRepository = {
  async upsertCurrentAndAppendSample(input: CreateLocationSampleInput) {
    const lat = new Prisma.Decimal(input.latitude.toFixed(6))
    const lng = new Prisma.Decimal(input.longitude.toFixed(6))
    const recordedAt = input.recordedAt ?? new Date()
    const source = (input.source?.trim() || 'app_gps').slice(0, 40)

    const [current, sample] = await prisma.$transaction([
      prisma.user.update({
        where: { id: input.userId },
        data: {
          lastLatitude: lat,
          lastLongitude: lng,
          lastLocationAccuracyM: input.accuracyM ?? null,
          lastLocatedAt: recordedAt,
        },
        select: {
          id: true,
          lastLatitude: true,
          lastLongitude: true,
          lastLocationAccuracyM: true,
          lastLocatedAt: true,
        },
      }),
      prisma.userLocationSample.create({
        data: {
          userId: input.userId,
          latitude: lat,
          longitude: lng,
          accuracyM: input.accuracyM ?? null,
          source,
          recordedAt,
        },
      }),
    ])

    return { current, sample }
  },

  async getCurrent(userId: string) {
    return prismaRead.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        lastLatitude: true,
        lastLongitude: true,
        lastLocationAccuracyM: true,
        lastLocatedAt: true,
      },
    })
  },

  async listHistory(userId: string, opts: { limit: number; cursor?: string }) {
    let cursorRecordedAt: Date | undefined
    if (opts.cursor) {
      const cur = await prismaRead.userLocationSample.findFirst({
        where: { id: opts.cursor, userId },
        select: { recordedAt: true },
      })
      cursorRecordedAt = cur?.recordedAt
    }

    return prismaRead.userLocationSample.findMany({
      where: {
        userId,
        ...(cursorRecordedAt ? { recordedAt: { lt: cursorRecordedAt } } : {}),
      },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
    })
  },

  async listRecentForAdmin(filter: {
    userId?: string
    from?: Date
    to?: Date
    cursor?: string
    limit: number
  }) {
    let cursorRecordedAt: Date | undefined
    if (filter.cursor) {
      const cur = await prismaRead.userLocationSample.findUnique({
        where: { id: filter.cursor },
        select: { recordedAt: true },
      })
      cursorRecordedAt = cur?.recordedAt
    }

    const recordedAt: Prisma.DateTimeFilter = {}
    if (filter.from) recordedAt.gte = filter.from
    if (filter.to) recordedAt.lte = filter.to
    if (cursorRecordedAt) recordedAt.lt = cursorRecordedAt

    return prismaRead.userLocationSample.findMany({
      where: {
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(Object.keys(recordedAt).length ? { recordedAt } : {}),
      },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            avatarUrl: true,
            country: true,
            lastLatitude: true,
            lastLongitude: true,
            lastLocatedAt: true,
          },
        },
      },
    })
  },
}
