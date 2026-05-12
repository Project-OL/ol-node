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

  it('accepts media messages without client s3Bucket (server assigns bucket)', () => {
    const ok = SendMessageSchema.safeParse({
      clientMessageId: '123e4567-e89b-12d3-a456-426614174000',
      type: 'IMAGE',
      mediaItems: [
        {
          s3Key: 'messaging/user-1/img.jpg',
          mediaType: 'IMAGE',
          fileName: 'img.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 100,
          order: 0,
        },
      ],
    })
    expect(ok.success).toBe(true)
  })
})
