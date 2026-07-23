import { getFirebaseApp } from '../config/firebase'
import { prisma } from '../config/database'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'push-notification' })

export type PushPayload = {
  title: string
  body: string
  data?: Record<string, string>
}

const STALE_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
])

export const pushNotificationService = {
  /** Sends to a single token. On a stale-token error, clears it from the owning user so future sends skip it. */
  async sendToToken(
    userId: string,
    token: string,
    payload: PushPayload,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await getFirebaseApp().messaging().send({
        token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      })
      return { success: true }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (code && STALE_TOKEN_ERROR_CODES.has(code)) {
        await prisma.user
          .update({ where: { id: userId }, data: { fcmToken: null, fcmTokenUpdatedAt: new Date() } })
          .catch(() => {})
      }
      log.warn({ err, userId }, 'push send failed')
      return { success: false, error: code ?? 'unknown' }
    }
  },

  /** Sends to up to 500 tokens per FCM multicast call — callers should chunk larger lists themselves. */
  async sendMulticast(
    tokens: string[],
    payload: PushPayload,
  ): Promise<{ successCount: number; failureCount: number }> {
    if (tokens.length === 0) return { successCount: 0, failureCount: 0 }
    const result = await getFirebaseApp().messaging().sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
    })
    return { successCount: result.successCount, failureCount: result.failureCount }
  },
}
