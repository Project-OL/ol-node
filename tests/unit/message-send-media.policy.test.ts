import { describe, it, expect } from 'vitest'
import { assertAudioS3KeyAllowed } from '../../src/services/message-send-media.service'

describe('assertAudioS3KeyAllowed', () => {
  const sender = '11111111-1111-1111-1111-111111111111'
  const conv = 'ckj4fi0wf0000ziqj7q3v9x0'

  it('allows conversation-scoped audio key', () => {
    expect(() =>
      assertAudioS3KeyAllowed(
        sender,
        conv,
        `messaging/audio/${conv}/2026/05/550e8400-e29b-41d4-a716-446655440000.m4a`,
      ),
    ).not.toThrow()
  })

  it('allows legacy per-user prefix', () => {
    expect(() =>
      assertAudioS3KeyAllowed(sender, conv, `messaging/${sender}/1700000000000-uuid.m4a`),
    ).not.toThrow()
  })

  it('rejects traversal', () => {
    expect(() => assertAudioS3KeyAllowed(sender, conv, `messaging/audio/${conv}/../x.m4a`)).toThrow()
  })
})
