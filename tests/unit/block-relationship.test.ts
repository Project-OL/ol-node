import { describe, it, expect, vi, beforeEach } from 'vitest'

const isBlocked = vi.fn()

vi.mock('../../src/repositories/block.repository', () => ({
  blockRepository: { isBlocked: (...args: unknown[]) => isBlocked(...args) },
}))

const { assertNotBlockedEitherWay, isBlockedEitherWay } = await import(
  '../../src/utils/block-relationship'
)

describe('block-relationship', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isBlocked.mockResolvedValue(false)
  })

  it('isBlockedEitherWay returns true when either direction is blocked', async () => {
    isBlocked.mockImplementation(async (a: string, b: string) => a === 'u1' && b === 'u2')
    expect(await isBlockedEitherWay('u1', 'u2')).toBe(true)
    expect(await isBlockedEitherWay('u2', 'u1')).toBe(true)
  })

  it('assertNotBlockedEitherWay throws USER_BLOCKED when recipient blocked sender', async () => {
    isBlocked.mockImplementation(async (blocker: string, blocked: string) =>
      blocker === 'b' && blocked === 'a' ? true : false,
    )
    await expect(assertNotBlockedEitherWay('a', 'b')).rejects.toMatchObject({
      code: 'USER_BLOCKED',
      statusCode: 403,
    })
  })

  it('assertNotBlockedEitherWay throws YOU_ARE_BLOCKED when sender blocked recipient', async () => {
    isBlocked.mockImplementation(async (blocker: string, blocked: string) =>
      blocker === 'a' && blocked === 'b' ? true : false,
    )
    await expect(assertNotBlockedEitherWay('a', 'b')).rejects.toMatchObject({
      code: 'YOU_ARE_BLOCKED',
      statusCode: 403,
    })
  })
})
