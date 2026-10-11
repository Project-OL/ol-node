import { describe, it, expect } from 'vitest'
import {
  BANK_FIELD_KEYS,
  applyBankFieldRuleUpdates,
  defaultBankFieldRules,
  resolveBankFieldRules,
  toBankFieldRuleDtos,
  validateBankFields,
} from '../../src/utils/bank-field-rules'

const valid = {
  firstName: 'Asha',
  lastName: "D'Souza",
  bankName: 'Punjab National Bank',
  ifscCode: 'punb0178400',
  accountNumber: '1701 5000 0118',
}

describe('bank field rules', () => {
  it('defaults: core bank fields required, contact fields optional, all format-checked', () => {
    const r = defaultBankFieldRules()
    expect(r.firstName).toEqual({ required: true, validate: true })
    expect(r.accountNumber.required).toBe(true)
    expect(r.email).toEqual({ required: false, validate: true })
    expect(r.upiId.required).toBe(false)
  })

  it('resolve ignores junk and keeps defaults for missing keys', () => {
    const r = resolveBankFieldRules({ ifscCode: { required: false }, bogus: { required: true }, email: 'x' })
    expect(r.ifscCode).toEqual({ required: false, validate: true })
    expect(r.email).toEqual({ required: false, validate: true })
    expect(resolveBankFieldRules(null)).toEqual(defaultBankFieldRules())
  })

  it('applies partial admin updates without touching other fields', () => {
    const next = applyBankFieldRuleUpdates(defaultBankFieldRules(), { ifscCode: { validate: false } })
    expect(next.ifscCode).toEqual({ required: true, validate: false })
    expect(next.accountNumber).toEqual({ required: true, validate: true })
  })

  it('dto lists every field in form order with a compilable pattern', () => {
    const dtos = toBankFieldRuleDtos(defaultBankFieldRules())
    expect(dtos.map((d) => d.field)).toEqual([...BANK_FIELD_KEYS])
    for (const d of dtos) expect(() => new RegExp(d.pattern, d.patternFlags)).not.toThrow()
  })

  it('accepts a valid form and normalises IFSC / account number', () => {
    const { values, issues } = validateBankFields(valid, defaultBankFieldRules())
    expect(issues).toEqual([])
    expect(values.ifscCode).toBe('PUNB0178400')
    expect(values.accountNumber).toBe('170150000118')
  })

  it('treats a blank optional email as absent (the app sends "")', () => {
    const { issues, values } = validateBankFields({ ...valid, email: undefined }, defaultBankFieldRules())
    expect(issues).toEqual([])
    expect(values.email).toBeUndefined()
  })

  it('rejects bad formats with a readable message', () => {
    const { issues } = validateBankFields(
      { ...valid, ifscCode: '!!!!', accountNumber: 'abcde', email: 'nope', phone: '12', upiId: 'x' },
      defaultBankFieldRules(),
    )
    const paths = issues.map((i) => i.path)
    expect(paths).toEqual(['ifscCode', 'accountNumber', 'upiId', 'email', 'phone'])
    expect(issues[0].message).toContain('IFSC code format is invalid')
  })

  it('flags missing required fields', () => {
    const { issues } = validateBankFields({ accountNumber: '123456789' }, defaultBankFieldRules())
    expect(issues.map((i) => i.path)).toEqual(['firstName', 'lastName', 'bankName', 'ifscCode'])
    expect(issues[0].message).toBe('First name is required')
  })

  it('admin toggles: not-required field may be blank; validate off falls back to min length', () => {
    const rules = applyBankFieldRuleUpdates(defaultBankFieldRules(), {
      ifscCode: { required: false },
      accountNumber: { validate: false },
    })
    const ok = validateBankFields({ ...valid, ifscCode: undefined, accountNumber: 'AB-123' }, rules)
    expect(ok.issues).toEqual([])
    const short = validateBankFields({ ...valid, accountNumber: 'A1' }, rules)
    expect(short.issues[0]).toMatchObject({ path: 'accountNumber' })
  })

  it('enforces DB max length even with validate off', () => {
    const rules = applyBankFieldRuleUpdates(defaultBankFieldRules(), { upiId: { validate: false } })
    const { issues } = validateBankFields({ ...valid, upiId: 'a'.repeat(51) }, rules)
    expect(issues).toEqual([{ path: 'upiId', message: 'UPI ID must be at most 50 characters' }])
  })

  it('needs an account number or UPI ID even when both are optional', () => {
    const rules = applyBankFieldRuleUpdates(defaultBankFieldRules(), {
      accountNumber: { required: false },
    })
    const { issues } = validateBankFields({ ...valid, accountNumber: undefined }, rules)
    expect(issues).toEqual([{ path: 'accountNumber|upiId', message: 'Enter a bank account number or a UPI ID' }])
    expect(validateBankFields({ ...valid, accountNumber: undefined, upiId: 'asha@ybl' }, rules).issues).toEqual([])
  })
})
