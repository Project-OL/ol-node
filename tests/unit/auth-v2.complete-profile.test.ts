import { describe, it, expect } from 'vitest'
import { completeProfileBodySchema } from '../../src/models/schemas'

const baseBody = {
  firstName: 'Tarzan',
  country: 'IN',
  gender: 'male' as const,
}

describe('completeProfileBodySchema avatarUrl', () => {
  it('accepts request without avatarUrl', () => {
    const parsed = completeProfileBodySchema.safeParse(baseBody)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.avatarUrl).toBeUndefined()
    }
  })

  it('accepts null or empty avatarUrl', () => {
    expect(completeProfileBodySchema.safeParse({ ...baseBody, avatarUrl: null }).success).toBe(
      true,
    )
    expect(completeProfileBodySchema.safeParse({ ...baseBody, avatarUrl: '' }).success).toBe(true)
  })

  it('accepts a valid avatar URL', () => {
    const parsed = completeProfileBodySchema.safeParse({
      ...baseBody,
      avatarUrl: 'https://cdn.example.com/avatars/user.jpg',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects invalid avatar URL when provided', () => {
    const parsed = completeProfileBodySchema.safeParse({
      ...baseBody,
      avatarUrl: 'not-a-url',
    })
    expect(parsed.success).toBe(false)
  })
})
