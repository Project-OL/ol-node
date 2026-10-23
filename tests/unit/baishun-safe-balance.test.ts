import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/config/database', () => ({ prisma: {}, prismaRead: {} }))

import { checkSessionUser, safeBalance } from '../../src/services/baishunSession.service'

// F16: game-provider balances stay exact JSON numbers; callback user must own the session.
describe('baishun safeBalance', () => {
  it('passes exact integers through as numbers', () => {
    expect(safeBalance(0n)).toBe(0)
    expect(safeBalance(123_456_789n)).toBe(123456789)
    expect(safeBalance(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('refuses a value that would be rounded', () => {
    expect(() => safeBalance(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(/exact number range/)
  })
})

describe('baishun checkSessionUser', () => {
  afterEach(() => {
    delete process.env.GAME_SESSION_USER_CHECK_MODE
  })
  it('accepts the session owner or a missing user_id', () => {
    expect(() => checkSessionUser('u1', 'u1', 'op')).not.toThrow()
    expect(() => checkSessionUser('u1', undefined, 'op')).not.toThrow()
  })
  it('log mode (default) only logs a mismatch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => checkSessionUser('u1', 'u2', 'change_balance')).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
  it('enforce mode refuses a mismatch', () => {
    process.env.GAME_SESSION_USER_CHECK_MODE = 'enforce'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => checkSessionUser('u1', 'u2', 'change_balance')).toThrow(/does not belong/)
    warn.mockRestore()
  })
})
