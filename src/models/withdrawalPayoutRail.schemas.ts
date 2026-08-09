import { z } from 'zod'

const RailUpdateSchema = z.object({
  feeRateBp: z.number().int().min(0).max(10_000).optional(),
  arrivalTime: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
})

export const PayoutRailConfigUpdateSchema = z.object({
  epay: RailUpdateSchema.optional(),
  bank: RailUpdateSchema.optional(),
})
