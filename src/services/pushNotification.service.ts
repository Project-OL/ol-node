import { getFirebaseApp } from '../config/firebase'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { PushDeliverySource, PushDeliveryStatus } from '@prisma/client'
import { pushDeliveryLogService } from './pushDeliveryLog.service'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'push-notification' })

export type PushPayload = {
  title: string
  body: string
  data?: Record<string, string>
}

export type PushSendContext = {
  source: PushDeliverySource
  adminUserId?: string | null
  campaignId?: string | null
  /** When false, skip writing push_delivery_logs (default true). */
  logDelivery?: boolean
}

export type PushRecipient = {
  userId: string
  token: string
}

const STALE_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
])

function statusFromResult(result: {
  success: boolean
  skipped?: boolean
}): PushDeliveryStatus {
  if (result.success) return PushDeliveryStatus.SENT
  if (result.skipped) return PushDeliveryStatus.SKIPPED
  return PushDeliveryStatus.FAILED
}

export const pushNotificationService = {
  /**
   * Looks up the user's FCM token and sends. No-ops (skipped) when the user has no token
   * or Firebase is not configured — safe to call from money/message paths.
   */
  async sendToUser(
    userId: string,
    payload: PushPayload,
    ctx?: PushSendContext,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true },
    })
    if (!user?.fcmToken) {
      const result = { success: false, skipped: true, error: 'NO_PUSH_TOKEN' as const }
      if (ctx && ctx.logDelivery !== false) {
        await pushDeliveryLogService.record({
          userId,
          adminUserId: ctx.adminUserId,
          source: ctx.source,
          status: PushDeliveryStatus.SKIPPED,
          campaignId: ctx.campaignId,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          errorCode: result.error,
        })
      }
      return result
    }
    return this.sendToToken(userId, user.fcmToken, payload, ctx)
  },

  /** Sends to a single token. On a stale-token error, clears it from the owning user so future sends skip it. */
  async sendToToken(
    userId: string,
    token: string,
    payload: PushPayload,
    ctx?: PushSendContext,
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    let result: { success: boolean; skipped?: boolean; error?: string }
    try {
      await getFirebaseApp().messaging().send({
        token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      })
      result = { success: true }
    } catch (err) {
      if (err instanceof AppError && err.code === 'FIREBASE_NOT_CONFIGURED') {
        log.debug({ userId }, 'push skipped: Firebase not configured')
        result = { success: false, skipped: true, error: 'FIREBASE_NOT_CONFIGURED' }
      } else {
        const code = (err as { code?: string } | null)?.code
        if (code && STALE_TOKEN_ERROR_CODES.has(code)) {
          await prisma.user
            .update({ where: { id: userId }, data: { fcmToken: null, fcmTokenUpdatedAt: new Date() } })
            .catch(() => {})
        }
        log.warn({ err, userId }, 'push send failed')
        result = { success: false, error: code ?? 'unknown' }
      }
    }

    if (ctx && ctx.logDelivery !== false) {
      await pushDeliveryLogService.record({
        userId,
        adminUserId: ctx.adminUserId,
        source: ctx.source,
        status: statusFromResult(result),
        campaignId: ctx.campaignId,
        title: payload.title,
        body: payload.body,
        data: payload.data,
        errorCode: result.error ?? null,
      })
    }
    return result
  },

  /** Sends to up to 500 tokens per FCM multicast call — callers should chunk larger lists themselves. */
  async sendMulticast(
    tokens: string[],
    payload: PushPayload,
  ): Promise<{ successCount: number; failureCount: number }> {
    const detailed = await this.sendMulticastToRecipients(
      tokens.map((token) => ({ userId: '', token })),
      payload,
    )
    return { successCount: detailed.successCount, failureCount: detailed.failureCount }
  },

  /**
   * Multicast with per-recipient outcomes. When recipients include userIds and `ctx` is set,
   * writes one push_delivery_logs row per recipient.
   */
  async sendMulticastToRecipients(
    recipients: PushRecipient[],
    payload: PushPayload,
    ctx?: PushSendContext,
  ): Promise<{
    successCount: number
    failureCount: number
    results: Array<{ userId: string; success: boolean; error?: string }>
  }> {
    if (recipients.length === 0) {
      return { successCount: 0, failureCount: 0, results: [] }
    }
    const tokens = recipients.map((r) => r.token)
    try {
      const result = await getFirebaseApp().messaging().sendEachForMulticast({
        tokens,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      })
      const results = recipients.map((r, i) => {
        const resp = result.responses[i]
        if (resp?.success) return { userId: r.userId, success: true }
        const code = resp?.error?.code
        return { userId: r.userId, success: false, error: code ?? 'unknown' }
      })

      for (let i = 0; i < recipients.length; i++) {
        const code = result.responses[i]?.error?.code
        if (code && STALE_TOKEN_ERROR_CODES.has(code) && recipients[i]!.userId) {
          await prisma.user
            .update({
              where: { id: recipients[i]!.userId },
              data: { fcmToken: null, fcmTokenUpdatedAt: new Date() },
            })
            .catch(() => {})
        }
      }

      if (ctx && ctx.logDelivery !== false) {
        await pushDeliveryLogService.recordMany(
          results
            .filter((r) => r.userId)
            .map((r) => ({
              userId: r.userId,
              adminUserId: ctx.adminUserId,
              source: ctx.source,
              status: r.success ? PushDeliveryStatus.SENT : PushDeliveryStatus.FAILED,
              campaignId: ctx.campaignId,
              title: payload.title,
              body: payload.body,
              data: payload.data,
              errorCode: r.error ?? null,
            })),
        )
      }

      return {
        successCount: result.successCount,
        failureCount: result.failureCount,
        results,
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'FIREBASE_NOT_CONFIGURED') {
        log.debug('multicast push skipped: Firebase not configured')
        const results = recipients.map((r) => ({
          userId: r.userId,
          success: false,
          error: 'FIREBASE_NOT_CONFIGURED',
        }))
        if (ctx && ctx.logDelivery !== false) {
          await pushDeliveryLogService.recordMany(
            results
              .filter((r) => r.userId)
              .map((r) => ({
                userId: r.userId,
                adminUserId: ctx.adminUserId,
                source: ctx.source,
                status: PushDeliveryStatus.SKIPPED,
                campaignId: ctx.campaignId,
                title: payload.title,
                body: payload.body,
                data: payload.data,
                errorCode: r.error,
              })),
          )
        }
        return { successCount: 0, failureCount: recipients.length, results }
      }
      throw err
    }
  },
}
