import { z } from 'zod'

export const adminInfraCostInventoryQuerySchema = z.object({
  refresh: z.coerce.boolean().optional(),
})

/** Optional year/month — omit both for the current UTC month; supply both for a specific month. */
export const adminInfraCostByServiceQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2020).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
    refresh: z.coerce.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.year === undefined) !== (val.month === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide both year and month, or omit both for the current UTC month',
        path: val.year === undefined ? ['year'] : ['month'],
      })
    }
  })

export type AdminInfraCostInventoryQuery = z.infer<typeof adminInfraCostInventoryQuerySchema>
export type AdminInfraCostByServiceQuery = z.infer<typeof adminInfraCostByServiceQuerySchema>
