import { z } from 'zod'

export const FaceLivenessConfigUpdateSchema = z
  .object({
    livenessRequired: z.boolean().optional(),
    credentialsRequired: z.boolean().optional(),
  })
  .refine((v) => v.livenessRequired !== undefined || v.credentialsRequired !== undefined, {
    message: 'At least one of livenessRequired or credentialsRequired is required',
  })

export type FaceLivenessConfigUpdateInput = z.infer<typeof FaceLivenessConfigUpdateSchema>
