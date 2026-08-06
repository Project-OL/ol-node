import { AppError } from '../middlewares/errorHandler'
import { userLocationRepository } from '../repositories/userLocation.repository'
import { userRepository } from '../repositories/user.repository'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'
import type { ReportLocationBody } from '../models/user-location.schemas'

function decimalToNumber(v: { toString(): string } | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v.toString())
  return Number.isFinite(n) ? n : null
}

function mapCurrent(row: {
  id: string
  lastLatitude: { toString(): string } | null
  lastLongitude: { toString(): string } | null
  lastLocationAccuracyM: number | null
  lastLocatedAt: Date | null
}) {
  return {
    userId: row.id,
    latitude: decimalToNumber(row.lastLatitude),
    longitude: decimalToNumber(row.lastLongitude),
    accuracyM: row.lastLocationAccuracyM,
    locatedAt: row.lastLocatedAt?.toISOString() ?? null,
  }
}

function mapSample(row: {
  id: string
  userId: string
  latitude: { toString(): string }
  longitude: { toString(): string }
  accuracyM: number | null
  source: string
  recordedAt: Date
}) {
  return {
    id: row.id,
    userId: row.userId,
    latitude: Number(row.latitude.toString()),
    longitude: Number(row.longitude.toString()),
    accuracyM: row.accuracyM,
    source: row.source,
    recordedAt: row.recordedAt.toISOString(),
  }
}

export const userLocationService = {
  async reportLocation(userId: string, body: ReportLocationBody) {
    const recordedAt = body.recordedAt ? new Date(body.recordedAt) : new Date()
    if (Number.isNaN(recordedAt.getTime())) {
      throw new AppError(400, 'Invalid recordedAt', 'INVALID_REQUEST')
    }
    // Reject fixes far in the future (>5m) or overly stale (>7d) to curb spoofing noise.
    const now = Date.now()
    if (recordedAt.getTime() > now + 5 * 60_000) {
      throw new AppError(400, 'recordedAt is in the future', 'INVALID_REQUEST')
    }
    if (recordedAt.getTime() < now - 7 * 86_400_000) {
      throw new AppError(400, 'recordedAt is too old', 'INVALID_REQUEST')
    }

    const { current, sample } = await userLocationRepository.upsertCurrentAndAppendSample({
      userId,
      latitude: body.latitude,
      longitude: body.longitude,
      accuracyM: body.accuracyM ?? null,
      source: body.source,
      recordedAt,
    })

    return {
      current: mapCurrent(current),
      sample: mapSample(sample),
    }
  },

  async getCurrent(userId: string) {
    const row = await userLocationRepository.getCurrent(userId)
    if (!row) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    return mapCurrent(row)
  },

  async listHistory(userId: string, opts: { limit: number; cursor?: string }) {
    const rows = await userLocationRepository.listHistory(userId, opts)
    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    return {
      items: page.map(mapSample),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    }
  },

  async getUserLocationsForAdmin(
    userId: string,
    opts: { limit: number; cursor?: string },
  ) {
    const exists = await userRepository.findById(userId)
    if (!exists) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const [current, history] = await Promise.all([
      this.getCurrent(userId),
      this.listHistory(userId, opts),
    ])
    return { userId, current, history }
  },

  async listForAdmin(query: {
    userId?: string
    from?: string
    to?: string
    limit: number
    cursor?: string
  }) {
    const from = query.from ? new Date(query.from) : undefined
    const to = query.to ? new Date(query.to) : undefined
    if (from && Number.isNaN(from.getTime())) {
      throw new AppError(400, 'Invalid from', 'INVALID_REQUEST')
    }
    if (to && Number.isNaN(to.getTime())) {
      throw new AppError(400, 'Invalid to', 'INVALID_REQUEST')
    }

    const rows = await userLocationRepository.listRecentForAdmin({
      userId: query.userId,
      from,
      to,
      cursor: query.cursor,
      limit: query.limit,
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    return {
      items: page.map((r) => {
        const displayName = buildUserDisplayName(r.user)
        return {
          ...mapSample(r),
          user: {
            userId: r.user.id,
            username: r.user.username,
            displayName,
            name: displayName,
            publicId: r.user.publicId.toString(),
            displayPublicId: resolveDisplayPublicId(r.user),
            avatarUrl: r.user.avatarUrl,
            country: r.user.country,
            currentLatitude: decimalToNumber(r.user.lastLatitude),
            currentLongitude: decimalToNumber(r.user.lastLongitude),
            lastLocatedAt: r.user.lastLocatedAt?.toISOString() ?? null,
          },
        }
      }),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    }
  },
}
