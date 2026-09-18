import { adminCountryUserSearchRepository } from '../repositories/adminCountryUserSearch.repository'
import { adminCountryAccessService } from './adminCountryAccess.service'
import { AppError } from '../middlewares/errorHandler'
import { formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import type { AdminRole } from '@prisma/client'

export const adminCountryUserSearchService = {
  /**
   * Country-scoped, minimal-field user search. Never returns email/phone.
   * `userId` is included only so the caller can target the existing
   * restriction/remove-avatar endpoints — the admin panel must not render it.
   */
  async search(
    adminId: string,
    role: AdminRole,
    query: { country?: string; q?: string; limit?: number },
  ) {
    const limit = query.limit ?? 20
    let countries: string[]

    if (role === 'SUPER_ADMIN') {
      if (!query.country) {
        throw new AppError(400, 'country is required', 'INVALID_REQUEST')
      }
      countries = [query.country]
    } else {
      const access = await adminCountryAccessService.getAccessSnapshot(adminId)
      if (!access.restricted) {
        throw new AppError(
          403,
          'No country access has been granted to this admin',
          'COUNTRY_ACCESS_FORBIDDEN',
        )
      }
      if (query.country) {
        if (!access.countries.has(query.country)) {
          throw new AppError(
            403,
            'You do not have access to this country',
            'COUNTRY_ACCESS_FORBIDDEN',
          )
        }
        countries = [query.country]
      } else {
        countries = [...access.countries]
      }
    }

    const rows = await adminCountryUserSearchRepository.search(countries, query.q ?? '', limit)
    return {
      users: rows.map((row) => ({
        userId: row.id,
        username: row.username,
        name: formatUserName(row),
        avatarUrl: row.avatarUrl,
        publicId: String(row.publicId),
        displayPublicId: resolveDisplayPublicId(row),
        country: row.country,
      })),
    }
  },
}
