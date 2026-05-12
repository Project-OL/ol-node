import { describe, it, expect } from 'vitest'
import { SendMessageSchema, GetUploadUrlsSchema } from '../../src/models/messaging.schemas'

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

  it('accepts optional audio metadata on media items', () => {
    const ok = SendMessageSchema.safeParse({
      clientMessageId: '123e4567-e89b-12d3-a456-426614174000',
      type: 'AUDIO',
      mediaItems: [
        {
          s3Key: 'messaging/audio/ckj4fi0wf0000ziqj7q3v9x0/2026/05/550e8400-e29b-41d4-a716-446655440000.m4a',
          mediaType: 'AUDIO',
          durationSec: 12,
        },
      ],
    })
    expect(ok.success).toBe(true)
  })
})

describe('GetUploadUrlsSchema', () => {
  it('requires conversationId when audio is requested', () => {
    const bad = GetUploadUrlsSchema.safeParse({
      files: [{ mediaType: 'AUDIO', fileName: 'a.m4a', mimeType: 'audio/mp4', sizeBytes: 100 }],
    })
    expect(bad.success).toBe(false)
    const ok = GetUploadUrlsSchema.safeParse({
      conversationId: 'ckj4fi0wf0000ziqj7q3v9x0',
      files: [{ mediaType: 'AUDIO', fileName: 'a.m4a', mimeType: 'audio/mp4', sizeBytes: 100 }],
    })
    expect(ok.success).toBe(true)
  })
})
