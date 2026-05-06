import { describe, it, expect } from 'vitest'

import { clientFrameSchema } from '../../src/realtime/frames.schemas'



const convId = 'clxxxxxxxxxxxxxxxxxxxxxxxxx'

const msgId = 'clxxxxxxxxxxxxxxxxxxxxxxxxx'



describe('clientFrameSchema', () => {

  it('parses READ frame', () => {

    const r = clientFrameSchema.safeParse({

      t: 'READ',

      conversationId: convId,

      lastReadMessageId: msgId,

    })

    expect(r.success).toBe(true)

  })



  it('parses JOIN_PRESENCE / LEAVE_PRESENCE', () => {

    const uid = '123e4567-e89b-12d3-a456-426614174000'

    expect(

      clientFrameSchema.safeParse({ t: 'JOIN_PRESENCE', userIds: [uid] }).success,

    ).toBe(true)

    expect(

      clientFrameSchema.safeParse({ t: 'LEAVE_PRESENCE', userIds: [uid] }).success,

    ).toBe(true)

  })

  it('parses RESUME', () => {
    const r = clientFrameSchema.safeParse({
      t: 'RESUME',
      conversations: [{ conversationId: convId, afterSeq: 10 }],
    })
    expect(r.success).toBe(true)
  })

})

