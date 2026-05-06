import { describe, it, expect } from 'vitest'
import { SendMessageSchema } from '../../src/models/messaging.schemas'

describe('SendMessageSchema', () => {
  it('requires clientMessageId (UUID v4 format)', () => {
    const bad = SendMessageSchema.safeParse({
      type: 'TEXT',
      content: 'hi',
    })
    expect(bad.success).toBe(false)

    const ok = SendMessageSchema.safeParse({
      clientMessageId: '123e4567-e89b-12d3-a456-426614174000',
      type: 'TEXT',
      content: 'hi',
    })
    expect(ok.success).toBe(true)
  })
})
