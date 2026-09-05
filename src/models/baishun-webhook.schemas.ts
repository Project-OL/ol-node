import { z } from 'zod'

/** `signature`/`signature_nonce`/`timestamp` are consumed by `verifyBaishunSignature`
 * (a preHandler, runs before these schemas) — included here only so `.parse()` doesn't
 * strip them as unknown keys. */
const CommonFieldsSchema = z.object({
  signature_nonce: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
})

export const BaishunGetSsTokenSchema = CommonFieldsSchema.extend({
  app_id: z.union([z.number(), z.string()]),
  user_id: z.string().min(1),
  code: z.string().min(1),
})

export const BaishunGetUserInfoSchema = CommonFieldsSchema.extend({
  app_id: z.union([z.number(), z.string()]),
  user_id: z.string().min(1),
  ss_token: z.string().min(1),
  client_ip: z.string().optional(),
  game_id: z.number(),
})

export const BaishunUpdateSsTokenSchema = CommonFieldsSchema.extend({
  app_id: z.union([z.number(), z.string()]),
  user_id: z.string().min(1),
  ss_token: z.string().min(1),
  game_id: z.number(),
})

export const BaishunChangeBalanceSchema = CommonFieldsSchema.extend({
  app_id: z.union([z.number(), z.string()]),
  user_id: z.string().min(1),
  ss_token: z.string().min(1),
  currency_diff: z.coerce.bigint(),
  diff_msg: z.enum(['bet', 'result', 'refund']),
  game_id: z.number(),
  game_round_id: z.string().optional(),
  room_id: z.string().optional(),
  change_time_at: z.number(),
  order_id: z.string().min(1),
  extend: z.string().optional(),
  msg_type: z.string().optional(),
  currency_type: z.number().optional(),
})
