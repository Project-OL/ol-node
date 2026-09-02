import { z } from 'zod'
import { OTP_PURPOSES } from './types'

export const OTP_DELIVERY_MEANS = ['email', 'whatsapp', 'sms', 'none'] as const
export type OtpDeliveryMeans = (typeof OTP_DELIVERY_MEANS)[number]

export const OTP_DELIVERY_AUDIT_STATUSES = ['success', 'failed', 'skipped'] as const
export type OtpDeliveryAuditStatus = (typeof OTP_DELIVERY_AUDIT_STATUSES)[number]

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())
  .transform((v) => new Date(v))

/** Optional UTC calendar month — omit both for no month filter; supply both together. */
const utcYearMonthFields = {
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
}

function refineUtcYearMonthOrRange<
  T extends { year?: number; month?: number; from?: Date; to?: Date },
>(val: T, ctx: z.RefinementCtx) {
  const hasYear = val.year !== undefined
  const hasMonth = val.month !== undefined
  if (hasYear !== hasMonth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide both year and month (UTC), or omit both',
      path: hasYear ? ['month'] : ['year'],
    })
  }
  if (hasYear && hasMonth && (val.from !== undefined || val.to !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use either year+month (UTC calendar month) or from/to, not both',
      path: ['year'],
    })
  }
}

export const adminListOtpDeliveryAuditsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    purpose: z.enum(OTP_PURPOSES).optional(),
    means: z.enum(OTP_DELIVERY_MEANS).optional(),
    status: z.enum(OTP_DELIVERY_AUDIT_STATUSES).optional(),
    userId: z.string().uuid().optional(),
    country: z.string().trim().min(1).max(100).optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    ...utcYearMonthFields,
  })
  .superRefine(refineUtcYearMonthOrRange)

export const adminOtpDeliveryAuditSummaryQuerySchema = z
  .object({
    purpose: z.enum(OTP_PURPOSES).optional(),
    means: z.enum(OTP_DELIVERY_MEANS).optional(),
    status: z.enum(OTP_DELIVERY_AUDIT_STATUSES).optional(),
    userId: z.string().uuid().optional(),
    country: z.string().trim().min(1).max(100).optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    ...utcYearMonthFields,
  })
  .superRefine(refineUtcYearMonthOrRange)

/** Optional year/month — omit both for current UTC month; supply both for a specific month. */
export const adminOtpMonthlyCostQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2020).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
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

/** WhatsApp/SMS pricing varies by destination country — email stays flat. */
export const adminOtpCountryRateUpsertSchema = z.object({
  means: z.enum(['whatsapp', 'sms']),
  country: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'country must be an ISO-3166-1 alpha-2 code')
    .transform((v) => v.toUpperCase()),
  rateMinor: z.coerce.number().int().min(0),
})

export const adminOtpCountryRateDeleteQuerySchema = z.object({
  means: z.enum(['whatsapp', 'sms']),
  country: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'country must be an ISO-3166-1 alpha-2 code')
    .transform((v) => v.toUpperCase()),
})

export type AdminListOtpDeliveryAuditsQuery = z.infer<typeof adminListOtpDeliveryAuditsQuerySchema>
export type AdminOtpDeliveryAuditSummaryQuery = z.infer<
  typeof adminOtpDeliveryAuditSummaryQuerySchema
>
export type AdminOtpMonthlyCostQuery = z.infer<typeof adminOtpMonthlyCostQuerySchema>
