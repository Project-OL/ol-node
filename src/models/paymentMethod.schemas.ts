import { z } from 'zod'

/** Trim strings, stringify numbers, and map blank / null to "not provided". */
function blankToUndefined(v: unknown): unknown {
  if (v == null) return undefined
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    const t = v.trim()
    return t === '' ? undefined : t
  }
  return v
}

export const BindEpaySchema = z.object({
  epayEmail: z.preprocess(
    (v) => {
      const t = blankToUndefined(v)
      return typeof t === 'string' ? t.toLowerCase() : t
    },
    z
      .string({
        error: (iss) =>
          iss.input === undefined ? 'ePay email is required' : 'ePay email must be text',
      })
      .max(255, 'ePay email must be at most 255 characters')
      .email('Invalid ePay email address'),
  ),
})

const bankText = (label: string) =>
  z.preprocess(
    blankToUndefined,
    // Per-field required / length / format rules are admin-configurable and applied in
    // userPaymentMethodService.bindBank (utils/bank-field-rules.ts); this only caps payload size.
    z
      // undefined falls through to the default "Required" (v3 invalid_type_error semantics)
      .string({ error: (iss) => (iss.input === undefined ? undefined : `${label} must be text`) })
      .max(500, `${label} is too long`)
      .optional(),
  )

export const BindBankSchema = z.object({
  firstName: bankText('First name'),
  lastName: bankText('Last name'),
  bankName: bankText('Bank name'),
  branch: bankText('Branch'),
  ifscCode: bankText('IFSC code'),
  accountNumber: bankText('Account number'),
  upiId: bankText('UPI ID'),
  email: bankText('Email'),
  phone: bankText('Phone number'),
})

export type BindBankInput = z.infer<typeof BindBankSchema>
