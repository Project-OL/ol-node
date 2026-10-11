/**
 * Admin-configurable validation for the BANK payment-method bind form.
 *
 * Every field has two admin toggles, stored as `withdrawal_payout_rail_config.bank_field_rules`:
 *   - `required`  — whether the host must fill it in;
 *   - `validate`  — whether its format check (below) is enforced.
 * Max lengths are always enforced: they mirror the DB column sizes.
 *
 * The same field list (with `pattern`) is served to the app via `GET /payment-methods`
 * and `GET /withdrawal/payout-rails` so the client can pre-validate with identical rules.
 */

export const BANK_FIELD_KEYS = [
  'firstName',
  'lastName',
  'bankName',
  'branch',
  'ifscCode',
  'accountNumber',
  'upiId',
  'email',
  'phone',
] as const

export type BankFieldKey = (typeof BANK_FIELD_KEYS)[number]

export type BankFieldRule = { required: boolean; validate: boolean }
export type BankFieldRules = Record<BankFieldKey, BankFieldRule>

export type BankFieldRuleDto = {
  field: BankFieldKey
  label: string
  required: boolean
  validate: boolean
  /** Applies whether or not `validate` is on. */
  minLength: number
  /** Applies whether or not `validate` is on (DB column limit). */
  maxLength: number
  /** Human-readable description of the format check enforced when `validate` is on. */
  format: string
  /** Regex source for the format check; compile with `patternFlags`. Apply only when `validate` is on. */
  pattern: string
  patternFlags: string
}

export type BankFieldValues = Partial<Record<BankFieldKey, string>>

export type BankFieldIssue = { path: BankFieldKey | 'accountNumber|upiId'; message: string }

type FieldDef = {
  label: string
  defaultRequired: boolean
  minLength: number
  maxLength: number
  format: string
  /** Short message for the app's global error pop-up (shown ~1 s) when the format check fails. */
  invalidMessage: string
  pattern: RegExp
  /** Applied after trimming, before any check, and to the stored value. */
  normalize?: (v: string) => string
}

const PERSON_NAME = /^[\p{L}][\p{L}\p{M} .'-]*$/u
const BANK_TEXT = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &.,'()/-]*$/u

export const BANK_FIELD_DEFS: Record<BankFieldKey, FieldDef> = {
  firstName: {
    label: 'First name',
    defaultRequired: true,
    minLength: 1,
    maxLength: 100,
    format: "Letters, spaces and . ' - only",
    invalidMessage: 'First name can only have letters',
    pattern: PERSON_NAME,
  },
  lastName: {
    label: 'Last name',
    defaultRequired: true,
    minLength: 1,
    maxLength: 100,
    format: "Letters, spaces and . ' - only",
    invalidMessage: 'Last name can only have letters',
    pattern: PERSON_NAME,
  },
  bankName: {
    label: 'Bank name',
    defaultRequired: true,
    minLength: 2,
    maxLength: 150,
    format: "Letters, numbers, spaces and & . , ' ( ) / - only",
    invalidMessage: 'Bank name has invalid characters',
    pattern: BANK_TEXT,
  },
  branch: {
    label: 'Branch',
    defaultRequired: false,
    minLength: 1,
    maxLength: 150,
    format: "Letters, numbers, spaces and & . , ' ( ) / - only",
    invalidMessage: 'Branch has invalid characters',
    pattern: BANK_TEXT,
  },
  ifscCode: {
    label: 'IFSC code',
    defaultRequired: true,
    minLength: 4,
    maxLength: 20,
    format: '11 characters: 4 letters, then 0, then 6 letters or digits (e.g. PUNB0178400)',
    invalidMessage: 'Invalid IFSC code (e.g. PUNB0178400)',
    pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    normalize: (v) => v.replace(/\s+/g, '').toUpperCase(),
  },
  accountNumber: {
    label: 'Account number',
    defaultRequired: true,
    minLength: 5,
    maxLength: 30,
    format: '9 to 18 digits only',
    invalidMessage: 'Account number must be 9-18 digits',
    pattern: /^[0-9]{9,18}$/,
    normalize: (v) => v.replace(/[\s-]+/g, ''),
  },
  upiId: {
    label: 'UPI ID',
    defaultRequired: false,
    minLength: 3,
    maxLength: 50,
    format: 'name@bank (e.g. 9876543210@ybl)',
    invalidMessage: 'Invalid UPI ID (e.g. name@ybl)',
    pattern: /^[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9]{1,}$/,
    normalize: (v) => v.replace(/\s+/g, ''),
  },
  email: {
    label: 'Email',
    defaultRequired: false,
    minLength: 3,
    maxLength: 255,
    format: 'A valid email address (e.g. name@example.com)',
    invalidMessage: 'Invalid email address',
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
    normalize: (v) => v.toLowerCase(),
  },
  phone: {
    label: 'Phone number',
    defaultRequired: false,
    minLength: 7,
    maxLength: 30,
    format: '7 to 15 digits, optional leading + (spaces, dashes and brackets are ignored)',
    invalidMessage: 'Invalid phone number',
    pattern: /^\+?[0-9]{7,15}$/,
    normalize: (v) => v.replace(/[\s()-]+/g, ''),
  },
}

export function defaultBankFieldRules(): BankFieldRules {
  const out = {} as BankFieldRules
  for (const key of BANK_FIELD_KEYS) {
    out[key] = { required: BANK_FIELD_DEFS[key].defaultRequired, validate: true }
  }
  return out
}

/** Merge the stored JSON (possibly null / partial / stale) over the defaults. */
export function resolveBankFieldRules(stored: unknown): BankFieldRules {
  const rules = defaultBankFieldRules()
  if (!stored || typeof stored !== 'object') return rules
  const obj = stored as Record<string, unknown>
  for (const key of BANK_FIELD_KEYS) {
    const entry = obj[key]
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.required === 'boolean') rules[key].required = e.required
    if (typeof e.validate === 'boolean') rules[key].validate = e.validate
  }
  return rules
}

export function applyBankFieldRuleUpdates(
  current: BankFieldRules,
  updates: Partial<Record<BankFieldKey, Partial<BankFieldRule>>>,
): BankFieldRules {
  const next = resolveBankFieldRules(current)
  for (const key of BANK_FIELD_KEYS) {
    const u = updates[key]
    if (!u) continue
    if (u.required != null) next[key].required = u.required
    if (u.validate != null) next[key].validate = u.validate
  }
  return next
}

export function toBankFieldRuleDtos(rules: BankFieldRules): BankFieldRuleDto[] {
  return BANK_FIELD_KEYS.map((field) => {
    const def = BANK_FIELD_DEFS[field]
    return {
      field,
      label: def.label,
      required: rules[field].required,
      validate: rules[field].validate,
      minLength: def.minLength,
      maxLength: def.maxLength,
      format: def.format,
      pattern: def.pattern.source,
      patternFlags: def.pattern.flags,
    }
  })
}

/**
 * Normalise and check a bind-bank payload against the active rules.
 * `input` values must already be trimmed with blanks mapped to undefined.
 */
export function validateBankFields(
  input: BankFieldValues,
  rules: BankFieldRules,
): { values: BankFieldValues; issues: BankFieldIssue[] } {
  const values: BankFieldValues = {}
  const issues: BankFieldIssue[] = []

  for (const key of BANK_FIELD_KEYS) {
    const def = BANK_FIELD_DEFS[key]
    const rule = rules[key]
    const raw = input[key]?.trim()
    const value = raw ? (def.normalize ? def.normalize(raw) : raw) : ''

    if (!value) {
      if (rule.required) issues.push({ path: key, message: `${def.label} is required` })
      continue
    }
    if (value.length > def.maxLength) {
      issues.push({
        path: key,
        message: `${def.label} is too long (max ${def.maxLength})`,
      })
      continue
    }
    if (rule.validate) {
      if (!def.pattern.test(value)) {
        issues.push({ path: key, message: def.invalidMessage })
        continue
      }
    } else if (value.length < def.minLength) {
      issues.push({
        path: key,
        message: `${def.label} is too short (min ${def.minLength})`,
      })
      continue
    }
    values[key] = value
  }

  // With every field optional a host could bind an empty record; payroll needs somewhere to pay.
  if (
    !values.accountNumber &&
    !values.upiId &&
    !issues.some((i) => i.path === 'accountNumber' || i.path === 'upiId')
  ) {
    issues.push({ path: 'accountNumber|upiId', message: 'Enter account number or UPI ID' })
  }

  return { values, issues }
}
