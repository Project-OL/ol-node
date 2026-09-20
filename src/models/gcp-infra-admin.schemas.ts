import { z } from 'zod'

export const gcpInfraCostByServiceQuerySchema = z
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

export const gcpInfraFlagsQuerySchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional(),
})

export const gcpInfraResourceHistoryQuerySchema = z.object({
  range: z.enum(['24h', '7d', '30d']).default('24h'),
})

const thresholdsSchema = z.object({
  cpuWarn: z.number().min(0).max(100).optional(),
  cpuCrit: z.number().min(0).max(100).optional(),
  memWarn: z.number().min(0).max(100).optional(),
  memCrit: z.number().min(0).max(100).optional(),
  diskWarn: z.number().min(0).max(100).optional(),
  diskCrit: z.number().min(0).max(100).optional(),
  connectionsWarn: z.number().min(0).optional(),
  connectionsCrit: z.number().min(0).optional(),
  eventLoopLagWarnMs: z.number().min(0).optional(),
  eventLoopLagCritMs: z.number().min(0).optional(),
})

export const gcpResourceConfigUpdateSchema = z.object({
  targetTierFor2x: z.string().max(200).optional().nullable(),
  suggestedNextTier: z.string().max(200).optional().nullable(),
  estimatedMonthlyCostUsd: z.number().min(0).max(999999.99).optional().nullable(),
  thresholds: thresholdsSchema.optional(),
  runbookMarkdown: z.string().max(20000).optional().nullable(),
})

export type GcpInfraCostByServiceQuery = z.infer<typeof gcpInfraCostByServiceQuerySchema>
export type GcpInfraFlagsQuery = z.infer<typeof gcpInfraFlagsQuerySchema>
export type GcpInfraResourceHistoryQuery = z.infer<typeof gcpInfraResourceHistoryQuerySchema>
export type GcpResourceConfigUpdate = z.infer<typeof gcpResourceConfigUpdateSchema>
