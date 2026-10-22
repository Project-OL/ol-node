import { describe, it, expect, vi } from 'vitest'

// SEC-01: LIVE_WEBHOOK_SECRET rotation accepts the previous value until it is removed.
const env = vi.hoisted(() => ({
  LIVE_WEBHOOK_SECRET: 'n'.repeat(40),
  LIVE_WEBHOOK_SECRET_PREVIOUS: 'o'.repeat(40) as string | undefined,
}))
vi.mock('../../src/config/env', () => ({ env }))

import { verifyLiveWebhookSecret } from '../../src/middlewares/liveWebhookAuth.middleware'

const call = (secret?: string) =>
  verifyLiveWebhookSecret(
    { headers: secret === undefined ? {} : { 'x-live-webhook-secret': secret } } as never,
    {} as never,
  )
const unauthorized = { statusCode: 401, code: 'UNAUTHORIZED' }

describe('verifyLiveWebhookSecret', () => {
  it('accepts the current and the previous secret', async () => {
    await expect(call('n'.repeat(40))).resolves.toBeUndefined()
    await expect(call('o'.repeat(40))).resolves.toBeUndefined()
  })

  it('rejects a wrong, short or missing secret', async () => {
    await expect(call('x'.repeat(40))).rejects.toMatchObject(unauthorized)
    await expect(call('n'.repeat(39))).rejects.toMatchObject(unauthorized)
    await expect(call('')).rejects.toMatchObject(unauthorized)
    await expect(call()).rejects.toMatchObject(unauthorized)
  })

  it('once _PREVIOUS is removed, the old secret stops working', async () => {
    env.LIVE_WEBHOOK_SECRET_PREVIOUS = undefined
    await expect(call('o'.repeat(40))).rejects.toMatchObject(unauthorized)
    await expect(call('n'.repeat(40))).resolves.toBeUndefined()
  })
})
