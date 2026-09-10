import { describe, expect, it } from 'vitest'
import {
  looksLikeEmail,
  normalizeAuthIdentifier,
  normalizeEmail,
  normalizeIdentifierGuess,
} from './auth-identifier'

describe('normalizeEmail', () => {
  it('lower-cases and trims', () => {
    expect(normalizeEmail('  Abcd@Gmail.COM ')).toBe('abcd@gmail.com')
  })

  it('is idempotent', () => {
    expect(normalizeEmail(normalizeEmail('Abcd@gmail.com'))).toBe('abcd@gmail.com')
  })
})

describe('normalizeAuthIdentifier', () => {
  it('lower-cases emails', () => {
    expect(normalizeAuthIdentifier('email', 'Lenzey21@gmail.com')).toBe('lenzey21@gmail.com')
  })

  it('leaves phone numbers alone apart from trimming', () => {
    expect(normalizeAuthIdentifier('phone', ' +919876543210 ')).toBe('+919876543210')
  })

  it('never touches the case of OAuth provider ids', () => {
    expect(normalizeAuthIdentifier('google', 'AbC123xyz')).toBe('AbC123xyz')
    expect(normalizeAuthIdentifier('apple', '001234.AbCdEf.5678')).toBe('001234.AbCdEf.5678')
  })

  it('leaves public ids untouched', () => {
    expect(normalizeAuthIdentifier('publicId', '34216809')).toBe('34216809')
  })
})

describe('normalizeIdentifierGuess', () => {
  it('lower-cases when the value looks like an email', () => {
    expect(looksLikeEmail('Abcd@gmail.com')).toBe(true)
    expect(normalizeIdentifierGuess('Abcd@gmail.com')).toBe('abcd@gmail.com')
  })

  it('does not lower-case non-emails', () => {
    expect(looksLikeEmail('+919876543210')).toBe(false)
    expect(normalizeIdentifierGuess('AbC123')).toBe('AbC123')
  })
})
