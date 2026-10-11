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

export const PayoutRailConfigUpdateSchema = z.object({
  epay: RailUpdateSchema.optional(),
  bank: RailUpdateSchema.optional(),
  bankFields: BankFieldRulesUpdateSchema.optional(),
})
