import { AppError } from '../middlewares/errorHandler'
import { prisma, prismaRead } from '../config/database'
import { redisClient, RedisKeys, AGENCY_COMMISSION_WINDOW_CONFIG_TTL } from '../config/redis'
import {
  resolveAgencyCommissionRollingWindowBounds,
  resolveAgencyCommissionRollingWindowDays,
  utcNow,
} from '../utils/datetime'

export type AgencyCommissionWindowConfigSnapshot = {
  windowDays: number
  windowHours: number
  windowMinutes: number
  totalMinutes: number
  updatedAt: string | null
  updatedByAdminId: string | null
}

const MAX_TOTAL_MINUTES = 365 * 24 * 60

function toSnapshot(row: {
  windowDays: number
  windowHours: number
  windowMinutes: number
  updatedAt: Date
  updatedByAdminId: string | null
}): AgencyCommissionWindowConfigSnapshot {
  const totalMinutes = row.windowDays * 24 * 60 + row.windowHours * 60 + row.windowMinutes
  return {
    windowDays: row.windowDays,
    windowHours: row.windowHours,
    windowMinutes: row.windowMinutes,
    totalMinutes,
    updatedAt: row.updatedAt.toISOString(),
    updatedByAdminId: row.updatedByAdminId,
  }
}

async function loadConfigRow(): Promise<AgencyCommissionWindowConfigSnapshot> {
  const row = await prismaRead.agencyCommissionConfig.findUnique({ where: { id: 1 } })
  if (!row) {
    throw new AppError(500, 'Agency commission config missing', 'CONFIG_ERROR')
  }
  return toSnapshot(row)
}

function assertValidDuration(days: number, hours: number, minutes: number): void {
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new AppError(400, 'windowDays must be an integer 0–365', 'INVALID_REQUEST')
  }
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
    throw new AppError(400, 'windowHours must be an integer 0–23', 'INVALID_REQUEST')
  }
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    throw new AppError(400, 'windowMinutes must be an integer 0–59', 'INVALID_REQUEST')
  }
  const totalMinutes = days * 24 * 60 + hours * 60 + minutes
  if (totalMinutes < 1) {
    throw new AppError(400, 'Rolling window must be at least 1 minute', 'INVALID_REQUEST')
  }
  if (totalMinutes > MAX_TOTAL_MINUTES) {
    throw new AppError(400, 'Rolling window cannot exceed 365 days', 'INVALID_REQUEST')
  }
}

export const agencyCommissionConfigService = {
  async getConfig(): Promise<AgencyCommissionWindowConfigSnapshot> {
    const key = RedisKeys.agencyCommissionWindowConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) return JSON.parse(hit) as AgencyCommissionWindowConfigSnapshot
    } catch {
      /* miss */
    }
    const snap = await loadConfigRow()
    try {
      await redisClient.setex(key, AGENCY_COMMISSION_WINDOW_CONFIG_TTL, JSON.stringify(snap))
    } catch {
      /* ignore */
    }
    return snap
  },

  async bustCache(): Promise<void> {
    try {
      await redisClient.del(RedisKeys.agencyCommissionWindowConfig())
    } catch {
      /* ignore */
    }
  },

  async updateConfig(
    adminId: string,
    updates: {
      windowDays?: number
      windowHours?: number
      windowMinutes?: number
    },
  ): Promise<AgencyCommissionWindowConfigSnapshot> {
    const current = await prisma.agencyCommissionConfig.findUnique({ where: { id: 1 } })
    if (!current) {
      throw new AppError(500, 'Agency commission config missing', 'CONFIG_ERROR')
    }

    const nextDays = updates.windowDays ?? current.windowDays
    const nextHours = updates.windowHours ?? current.windowHours
    const nextMinutes = updates.windowMinutes ?? current.windowMinutes
    assertValidDuration(nextDays, nextHours, nextMinutes)

    if (
      updates.windowDays == null &&
      updates.windowHours == null &&
      updates.windowMinutes == null
    ) {
      throw new AppError(400, 'Nothing to update', 'INVALID_REQUEST')
    }

    const row = await prisma.agencyCommissionConfig.update({
      where: { id: 1 },
      data: {
        windowDays: nextDays,
        windowHours: nextHours,
        windowMinutes: nextMinutes,
        updatedByAdminId: adminId,
      },
    })

    await this.bustCache()
    return toSnapshot(row)
  },

  /**
   * Precise half-open UTC window `[from, toExclusive)` for tier matching / progress.
   * Duration comes from admin config (days + hours + minutes from `now`).
   */
  async resolveRollingWindowBounds(
    now: Date = utcNow(),
  ): Promise<{ from: Date; toExclusive: Date; totalMinutes: number }> {
    const cfg = await this.getConfig()
    return resolveAgencyCommissionRollingWindowBounds(
      {
        days: cfg.windowDays,
        hours: cfg.windowHours,
        minutes: cfg.windowMinutes,
      },
      now,
    )
  },

  /** Inclusive UTC calendar days overlapping the precise rolling window (day-bucket reports only). */
  async resolveRollingWindowDays(now: Date = utcNow()): Promise<{ fromDay: Date; toDay: Date }> {
    const cfg = await this.getConfig()
    return resolveAgencyCommissionRollingWindowDays(
      {
        days: cfg.windowDays,
        hours: cfg.windowHours,
        minutes: cfg.windowMinutes,
      },
      now,
    )
  },
}
