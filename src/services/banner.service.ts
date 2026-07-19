import type { Banner } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import { bannerRepository, type AdminBannerStatusFilter } from '../repositories/banner.repository'
import type { BannerStatus } from '../models/banner.schemas'
import type { CreateBannerBody, PatchBannerBody } from '../models/banner.schemas'

const DAY_MS = 24 * 60 * 60 * 1000

export function deriveBannerStatus(banner: Banner, now = new Date()): BannerStatus {
  if (banner.endAt.getTime() < now.getTime()) return 'COMPLETED'
  if (!banner.enabled) return 'STOPPED'
  if (banner.startAt.getTime() > now.getTime()) return 'SCHEDULED'
  return 'ACTIVE'
}

export interface BannerPublicDto {
  id: string
  title: string
  imageUrl: string
  position: string
  startAt: string
  endAt: string
}

export interface BannerAdminDto extends BannerPublicDto {
  enabled: boolean
  status: BannerStatus
  createdByAdminId: string | null
  createdAt: string
  updatedAt: string
}

function toPublicDto(b: Banner): BannerPublicDto {
  return {
    id: b.id,
    title: b.title,
    imageUrl: b.imageUrl,
    position: b.position,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
  }
}

export function toAdminDto(b: Banner, now = new Date()): BannerAdminDto {
  return {
    ...toPublicDto(b),
    enabled: b.enabled,
    status: deriveBannerStatus(b, now),
    createdByAdminId: b.createdByAdminId,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  }
}

/** Fisher-Yates: fresh random order on every fetch, per product requirement. */
function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

function resolveEndAt(startAt: Date, endAt?: string, validityDays?: number): Date {
  const resolved =
    endAt != null ? new Date(endAt) : new Date(startAt.getTime() + (validityDays ?? 0) * DAY_MS)
  if (resolved.getTime() <= startAt.getTime()) {
    throw new AppError(400, 'endAt must be after startAt', 'INVALID_BANNER_WINDOW')
  }
  return resolved
}

export const bannerService = {
  /** User-facing: banners live right now, shuffled on every call. */
  async getActiveBanners(params: { position?: string; limit: number }): Promise<{
    banners: BannerPublicDto[]
  }> {
    const rows = await bannerRepository.findActive(new Date(), params.position, params.limit)
    return { banners: shuffle(rows).map(toPublicDto) }
  },
}

export const bannerAdminService = {
  async create(body: CreateBannerBody, adminId: string): Promise<BannerAdminDto> {
    const startAt = new Date(body.startAt)
    const endAt = resolveEndAt(startAt, body.endAt, body.validityDays)
    const banner = await bannerRepository.create({
      title: body.title,
      imageUrl: body.imageUrl,
      position: body.position,
      startAt,
      endAt,
      enabled: body.enabled,
      createdByAdminId: adminId,
    })
    return toAdminDto(banner)
  },

  async list(params: {
    status: AdminBannerStatusFilter
    position?: string
    page: number
    limit: number
  }): Promise<{
    banners: BannerAdminDto[]
    total: number
    page: number
    limit: number
  }> {
    const now = new Date()
    const { items, total } = await bannerRepository.adminList({ ...params, now })
    return {
      banners: items.map((b) => toAdminDto(b, now)),
      total,
      page: params.page,
      limit: params.limit,
    }
  },

  async getById(id: string): Promise<BannerAdminDto> {
    const banner = await bannerRepository.findById(id)
    if (!banner) throw new AppError(404, 'Banner not found', 'BANNER_NOT_FOUND')
    return toAdminDto(banner)
  },

  async patch(id: string, body: PatchBannerBody): Promise<BannerAdminDto> {
    const existing = await bannerRepository.findById(id)
    if (!existing) throw new AppError(404, 'Banner not found', 'BANNER_NOT_FOUND')

    const startAt = body.startAt != null ? new Date(body.startAt) : existing.startAt
    let endAt = existing.endAt
    if (body.endAt != null || body.validityDays != null) {
      endAt = resolveEndAt(startAt, body.endAt, body.validityDays)
    } else if (body.startAt != null && endAt.getTime() <= startAt.getTime()) {
      throw new AppError(400, 'endAt must be after startAt', 'INVALID_BANNER_WINDOW')
    }

    const banner = await bannerRepository.update(id, {
      ...(body.title != null ? { title: body.title } : {}),
      ...(body.imageUrl != null ? { imageUrl: body.imageUrl } : {}),
      ...(body.position != null ? { position: body.position } : {}),
      ...(body.startAt != null ? { startAt } : {}),
      ...(body.endAt != null || body.validityDays != null ? { endAt } : {}),
      ...(body.enabled != null ? { enabled: body.enabled } : {}),
    })
    return toAdminDto(banner)
  },

  async delete(id: string): Promise<void> {
    const existing = await bannerRepository.findById(id)
    if (!existing) throw new AppError(404, 'Banner not found', 'BANNER_NOT_FOUND')
    await bannerRepository.delete(id)
  },
}
