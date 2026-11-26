import { z } from 'zod'

const RailUpdateSchema = z.object({
  feeRateBp: z.number().int().min(0).max(10_000).optional(),
  arrivalTime: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
})

const BankFieldRuleUpdateSchema = z
  .object({
    required: z.boolean().optional(),
    validate: z.boolean().optional(),
  })
  .strict()
  .optional()

/** Partial per-field toggles; keys mirror `BANK_FIELD_KEYS` in utils/bank-field-rules.ts. */
const BankFieldRulesUpdateSchema = z
  .object({
    firstName: BankFieldRuleUpdateSchema,
    lastName: BankFieldRuleUpdateSchema,
    bankName: BankFieldRuleUpdateSchema,
    branch: BankFieldRuleUpdateSchema,
    ifscCode: BankFieldRuleUpdateSchema,
    accountNumber: BankFieldRuleUpdateSchema,
    upiId: BankFieldRuleUpdateSchema,
    email: BankFieldRuleUpdateSchema,
    phone: BankFieldRuleUpdateSchema,
  })
  .strict()

/** EPAY is switched per audience; legacy `enabled` maps to the agents' switch only. */
const EpayRailUpdateSchema = RailUpdateSchema.extend({
  enabledForAgents: z.boolean().optional(),
  enabledForUsers: z.boolean().optional(),
  /** EPAY-only minimum gross USD per withdrawal (USD and USDT). BANK uses the payroll minimum. */
  minWithdrawalUsd: z.number().positive().max(10_000_000).optional(),
})

export const PayoutRailConfigUpdateSchema = z.object({
  epay: EpayRailUpdateSchema.optional(),
  bank: RailUpdateSchema.optional(),
  bankFields: BankFieldRulesUpdateSchema.optional(),
})
