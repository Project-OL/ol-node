import { z } from 'zod'

/** GET /admin/users/country-search */
export const AdminCountryUserSearchQuerySchema = z.object({
  country: z.string().trim().min(1).max(100).optional(),
  q: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

export type AdminCountryUserSearchQuery = z.infer<typeof AdminCountryUserSearchQuerySchema>
