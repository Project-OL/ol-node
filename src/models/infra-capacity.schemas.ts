import { z } from 'zod'

/** INF-23: POST /admin/infra/capacity/step-up */
export const infraCapacityStepUpSchema = z.object({
  opsPassword: z.string().min(1).max(200),
})

/** INF-23: PUT /admin/infra/capacity. The scaler re-checks every cap; these are only shape checks. */
export const infraCapacityChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api'),
    minReplicas: z.number().int().min(1).max(8),
    maxReplicas: z.number().int().min(1).max(8),
    stepUpToken: z.string().min(32).max(128),
    reason: z.string().trim().max(300).optional(),
  }),
  z.object({
    kind: z.literal('redis'),
    sizeGb: z.number().int().min(1).max(16),
    stepUpToken: z.string().min(32).max(128),
    reason: z.string().trim().max(300).optional(),
  }),
])

export const infraCapacityOperationQuerySchema = z.object({
  ref: z.string().regex(/^[A-Za-z0-9_./-]{1,300}$/),
})

export type InfraCapacityChange = z.infer<typeof infraCapacityChangeSchema>
