import { z } from 'zod'

/** `?date=YYYY-MM-DD` (IST day); omitted = today. */
export const trafficDayQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
})

/** `?days=7|30`; omitted = 7. */
export const trafficRangeQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => d === 7 || d === 30, 'days must be 7 or 30')
    .optional(),
})
