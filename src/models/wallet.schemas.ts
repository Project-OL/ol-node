import { z } from "zod";

function queryStringArray<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return undefined;
    return Array.isArray(v) ? v : [v];
  }, z.array(itemSchema).optional());
}

// ── Shared ──────────────────────────────────────────────────────────────────

export const CursorPaginationSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const DateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// ── Coins ───────────────────────────────────────────────────────────────────

export const CoinTxTypeEnum = z.enum([
  "TOPUP",
  "GIFT_SEND",
  "GIFT_REFUND",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "VIP_PURCHASE",
  "VIP_REWARD",
  "DAILY_LOGIN",
  "WEEKLY_TOPUP",
  "PLATFORM_REWARD",
  "EXPIRE",
  "ADJUSTMENT",
  "VIDEO_CALL",
  "USERNAME_CHANGE",
]);

export const CoinHistoryQuerySchema = DateRangeSchema.merge(
  CursorPaginationSchema,
).extend({
  types: queryStringArray(CoinTxTypeEnum),
});

export const TopupInitiateSchema = z.object({
  packageId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
});

export const TopupConfirmSchema = z.object({
  orderId: z.string().uuid(),
  gatewayRef: z.string().max(256),
  idempotencyKey: z.string().min(8).max(128),
});

// ── Points ─────────────────────────────────────────────────────────────────

export const PointTxTypeEnum = z.enum([
  "LIVESTREAM_GIFT",
  "SUBSCRIPTION",
  "COMMISSION",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "MYSTERY_CHEST",
  "PLATFORM_REWARD",
  "WITHDRAWAL",
  "WITHDRAWAL_REFUND",
  "ADJUSTMENT",
  "VIDEO_CALL",
  "GIFT_RECEIVE",
  "AGENCY_FORCE_EXIT_PENALTY",
  "AGENT_COMMISSION",
  "AGENT_POINT_TRANSFER",
]);

export const PointHistoryQuerySchema = DateRangeSchema.merge(
  CursorPaginationSchema,
).extend({
  types: queryStringArray(PointTxTypeEnum),
});

export const WithdrawInitiateSchema = z.object({
  amountPoints: z.coerce.bigint().positive(),
  paymentMethodId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  notes: z.string().max(500).optional(),
});
