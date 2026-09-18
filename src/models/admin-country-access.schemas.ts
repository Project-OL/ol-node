import { z } from 'zod'

export const CountrySchema = z.string().trim().min(1).max(100)

/** PUT /admin/country-access/:adminId — replace the admin's granted-country set entirely. */
export const ReplaceCountryAccessSchema = z.object({
  countries: z.array(CountrySchema).max(200),
})

export const CountryAccessAdminParamsSchema = z.object({
  adminId: z.string().min(1),
})

export type ReplaceCountryAccessInput = z.infer<typeof ReplaceCountryAccessSchema>
