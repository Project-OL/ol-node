import { redisClient, RedisKeys, ADMIN_COUNTRY_ACCESS_TTL } from '../config/redis'
import { adminCountryAccessRepository } from '../repositories/adminCountryAccess.repository'
import { systemAdminRepository } from '../repositories/systemAdmin.repository'
import { AppError } from '../middlewares/errorHandler'
import type { AdminRole } from '@prisma/client'

/** Per-request country-access snapshot for one admin. */
export interface AdminCountryAccessSnapshot {
  /** True when the admin has >=1 granted country — country gating applies. */
  restricted: boolean
  /** Granted countries (empty when unrestricted). */
  countries: Set<string>
}

interface CachedAccess {
  restricted: boolean
  countries: string[]
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))]
}

async function bustAccessCache(adminId: string): Promise<void> {
  try {
    await redisClient.del(RedisKeys.adminCountryAccess(adminId))
  } catch {
    // Cache bust is best-effort; TTL (120s) bounds staleness.
  }
}

export const adminCountryAccessService = {
  /**
   * Redis-cached permission snapshot, same shape/TTL convention as
   * `adminViewService.getAccessSnapshot`. SUPER_ADMIN never needs to call this
   * (callers should bypass for SUPER_ADMIN before reaching here).
   */
  async getAccessSnapshot(adminId: string): Promise<AdminCountryAccessSnapshot> {
    const key = RedisKeys.adminCountryAccess(adminId)
    try {
      const cached = await redisClient.get(key)
      if (cached) {
        const parsed = JSON.parse(cached) as CachedAccess
        return { restricted: parsed.restricted, countries: new Set(parsed.countries) }
      }
    } catch {
      // Fall through to DB on any Redis/parse failure.
    }

    const countries = await adminCountryAccessRepository.listForAdmin(adminId)
    const snapshot: CachedAccess = { restricted: countries.length > 0, countries }

    try {
      await redisClient.set(key, JSON.stringify(snapshot), 'EX', ADMIN_COUNTRY_ACCESS_TTL)
    } catch {
      // Cache write is best-effort.
    }
    return { restricted: snapshot.restricted, countries: new Set(countries) }
  },

  /**
   * SUPER_ADMIN always passes. Otherwise, an admin with zero grants is
   * unrestricted (legacy behavior); an admin with >=1 grant may only act on
   * users whose country is in that set. A user with no country on file can
   * never be reached by a country-restricted admin.
   */
  async assertAllowed(
    adminId: string,
    role: AdminRole,
    targetCountry: string | null,
  ): Promise<void> {
    if (role === 'SUPER_ADMIN') return
    const access = await this.getAccessSnapshot(adminId)
    if (!access.restricted) return
    if (!targetCountry || !access.countries.has(targetCountry)) {
      throw new AppError(
        403,
        'You do not have access to this user’s country',
        'COUNTRY_ACCESS_FORBIDDEN',
      )
    }
  },

  async listForAdmin(adminId: string): Promise<{ adminId: string; countries: string[] }> {
    const countries = await adminCountryAccessRepository.listForAdmin(adminId)
    return { adminId, countries }
  },

  /** Replace the target admin's granted-country set. Empty array clears all grants. */
  async replaceForAdmin(
    targetAdminId: string,
    countries: string[],
    createdByAdminId: string,
  ): Promise<{ adminId: string; countries: string[] }> {
    const admin = await systemAdminRepository.findById(targetAdminId)
    if (!admin) {
      throw new AppError(404, 'Admin not found', 'ADMIN_NOT_FOUND')
    }
    if (admin.role === 'SUPER_ADMIN') {
      throw new AppError(
        400,
        'SUPER_ADMIN always has full country access',
        'ADMIN_COUNTRY_ACCESS_SUPER_ADMIN',
      )
    }

    const unique = dedupe(countries)
    await adminCountryAccessRepository.replaceForAdmin(targetAdminId, unique, createdByAdminId)
    await bustAccessCache(targetAdminId)

    return { adminId: targetAdminId, countries: unique.sort((a, b) => a.localeCompare(b)) }
  },
}
