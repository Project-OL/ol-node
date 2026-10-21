import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { verifyRotating } from '../../src/utils/jwt'

// SEC-01: rotate JWT secrets without logging anyone out.
const CURRENT = 'c'.repeat(48)
const PREVIOUS = 'p'.repeat(48)
const OTHER = 'o'.repeat(48)
const opts = { algorithms: ['HS256'] as jwt.Algorithm[] }

describe('verifyRotating', () => {
  it('accepts a token signed with the current secret', () => {
    const t = jwt.sign({ userId: 'u1' }, CURRENT, { algorithm: 'HS256' })
    expect(verifyRotating<{ userId: string }>(t, CURRENT, PREVIOUS, opts).userId).toBe('u1')
  })

  it('accepts a token signed with the previous secret during the grace period', () => {
    const t = jwt.sign({ userId: 'u2' }, PREVIOUS, { algorithm: 'HS256' })
    expect(verifyRotating<{ userId: string }>(t, CURRENT, PREVIOUS, opts).userId).toBe('u2')
  })

  it('rejects the old token once the previous secret is removed', () => {
    const t = jwt.sign({ userId: 'u2' }, PREVIOUS, { algorithm: 'HS256' })
    expect(() => verifyRotating(t, CURRENT, undefined, opts)).toThrow('invalid signature')
  })

  it('rejects a token signed with any other secret', () => {
    const t = jwt.sign({ userId: 'x' }, OTHER, { algorithm: 'HS256' })
    expect(() => verifyRotating(t, CURRENT, PREVIOUS, opts)).toThrow('invalid signature')
  })

  it('an expired current-secret token stays expired (no fallback on expiry)', () => {
    const t = jwt.sign({ userId: 'u3', exp: Math.floor(Date.now() / 1000) - 60 }, CURRENT, {
      algorithm: 'HS256',
    })
    expect(() => verifyRotating(t, CURRENT, PREVIOUS, opts)).toThrow(jwt.TokenExpiredError)
  })

  it('an expired previous-secret token is reported as expired, not as a bad signature', () => {
    const t = jwt.sign({ userId: 'u4', exp: Math.floor(Date.now() / 1000) - 60 }, PREVIOUS, {
      algorithm: 'HS256',
    })
    expect(() => verifyRotating(t, CURRENT, PREVIOUS, opts)).toThrow(jwt.TokenExpiredError)
  })

  it('keeps the algorithm pin (an unsigned token is never accepted)', () => {
    const t = jwt.sign({ userId: 'none' }, '', { algorithm: 'none' })
    expect(() => verifyRotating(t, CURRENT, PREVIOUS, opts)).toThrow()
  })
})
