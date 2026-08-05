import Fastify from 'fastify'
import crypto from 'crypto'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import websocket from '@fastify/websocket'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import compress from '@fastify/compress'

import { env } from './config/env'
import { logger } from './config/logger'
import { redisClient } from './config/redis'
import { errorHandler } from './middlewares/errorHandler'
import { notFoundHandler } from './middlewares/notFoundHandler'
import { requestIdHook, requestLoggerHook } from './middlewares/requestLogger'
import {
  requestTimingOnRequest,
  requestTimingOnResponse,
  requestTimingOnSend,
} from './middlewares/requestTiming.middleware'
import { requestMetrics } from './utils/requestMetrics'

import authRoutes from './routes/v1/auth.routes'
import securityPasswordRoutes from './routes/v1/security-password.routes'
import deviceRoutes from './routes/v1/device.routes'
import privacyRoutes from './routes/v1/privacy.routes'
import accountDeletionRoutes from './routes/v1/account-deletion.routes'
import uploadRoutes from './routes/v1/upload.routes'
import healthRoutes from './routes/v1/health.routes'
import socialRoutes from './routes/v1/social.routes'
import usersRoutes from './routes/v1/users.routes'
import settingsRoutes from './routes/v1/settings.routes'
import postRoutes from './routes/v1/post.routes'
import conversationRoutes from './routes/v1/conversation.routes'
import messageRoutes from './routes/v1/message.routes'
import blockRoutes from './routes/v1/block.routes'
import reportRoutes from './routes/v1/report.routes'
import reminderRoutes from './routes/v1/reminder.routes'
import { walletCoinsRoutes } from './routes/v1/wallet-coins.routes'
import { walletPointsRoutes } from './routes/v1/wallet-points.routes'
import { walletLevelsRoutes } from './routes/v1/wallet-levels.routes'
import callRoutes from './routes/v1/call.routes'
import giftRoutes from './routes/v1/gift.routes'
import giftGalleryRoutes from './routes/v1/gift-gallery.routes'
import fanRankingRoutes from './routes/v1/fan-ranking.routes'
import subscriptionRoutes from './routes/v1/subscription.routes'
import guardianRoutes from './routes/v1/guardian.routes'
import { registerAdminAuthRoutes } from './routes/v1/admin-auth.routes'
import otpDeliveryAdminRoutes from './routes/v1/otp-delivery-admin.routes'
import superHostRoutes from './routes/v1/super-host.routes'
import { supportRoutes } from './routes/v1/support.routes'
import storeRoutes from './routes/v1/store.routes'
import storeAdminRoutes from './routes/v1/store-admin.routes'
import giftAdminRoutes from './routes/v1/gift-admin.routes'
import { richTierRoutes } from './routes/v1/rich-tier.routes'
import vipMembershipRoutes from './routes/v1/vip-membership.routes'
import rewardsRoutes from './routes/v1/rewards.routes'
import agencyRoutes from './routes/v1/agency.routes'
import agencyAdminRoutes from './routes/v1/agency-admin.routes'
import questionnaireRoutes from './routes/v1/questionnaire.routes'
import questionnaireAdminRoutes from './routes/v1/questionnaire-admin.routes'
import csaAdminRoutes from './routes/v1/csa-admin.routes'
import supportAdminRoutes from './routes/v1/support-admin.routes'
import userAdminRoutes from './routes/v1/user-admin.routes'
import platformMessageAdminRoutes from './routes/v1/platform-message-admin.routes'
import pushNotificationAdminRoutes from './routes/v1/push-notification-admin.routes'
import ledgerAuditAdminRoutes from './routes/v1/ledger-audit-admin.routes'
import adminUserWalletRoutes from './routes/v1/admin-user-wallet.routes'
import adminTransactionsRoutes from './routes/v1/admin-transactions.routes'
import adminUserModerationRoutes from './routes/v1/admin-user-moderation.routes'
import adminUserRestrictionRoutes from './routes/v1/admin-user-restriction.routes'
import postAdminRoutes from './routes/v1/post-admin.routes'
import faceVerificationAdminRoutes from './routes/v1/face-verification-admin.routes'
import faceVerificationRoutes from './routes/v1/face-verification.routes'
import faceRegistrationRoutes from './routes/v1/face-registration.routes'
import livePhotoRoutes from './routes/v1/live-photo.routes'
import agencyKycRoutes from './routes/v1/agency-kyc.routes'
import agencyCoinsellerRoutes from './routes/v1/agency-coinseller.routes'
import coinTradingRoutes from './routes/v1/coin-trading.routes'
import { paymentMethodRoutes } from './routes/v1/payment-method.routes'
import { withdrawalRoutes } from './routes/v1/withdrawal.routes'
import { webhooksRoutes } from './routes/v1/webhooks.routes'
import bannerRoutes from './routes/v1/banner.routes'
import bannerAdminRoutes from './routes/v1/banner-admin.routes'
import customGiftRoutes from './routes/v1/custom-gift.routes'
import customGiftAdminRoutes from './routes/v1/custom-gift-admin.routes'
import adminViewRoutes from './routes/v1/admin-view.routes'
import { schedulePublicIdPregen } from './queues/public-id-pregen.queue'
import { publicIdPreGenerationService } from './services/public-id-pre-generation.service'
import { rootLogger } from './utils/rootLogger'
import { registerRealtimeGateway } from './realtime/ws.gateway'

const REQUEST_TIMEOUT_MS = 30_000

export async function buildApp() {
  const app = Fastify({
    logger,
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    connectionTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 30_000,
    bodyLimit: env.REQUEST_BODY_LIMIT_BYTES,
  })

  app.setReplySerializer((payload, _statusCode) =>
    JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  )

  await app.register(compress, {
    global: true,
    encodings: ['gzip', 'deflate', 'br'],
  })

  if (env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: 'Offoo REST API',
          version: env.API_VERSION,
          description: 'Offoo VoIP REST API',
        },
        servers: [{ url: `/api/${env.API_VERSION}`, description: 'API v1' }],
      },
    })
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list' },
    })
  }

  await app.register(jwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { algorithm: 'HS256', expiresIn: env.JWT_ACCESS_EXPIRES_IN },
  })

  await app.register(websocket)

  await app.register(helmet, {
    contentSecurityPolicy: env.NODE_ENV === 'production',
  })

  const isLocalhostOrigin = (origin: string): boolean => {
    try {
      const url = new URL(origin)
      return (
        url.hostname === 'localhost' && (url.protocol === 'http:' || url.protocol === 'https:')
      )
    } catch {
      return false
    }
  }

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true)
        return
      }
      if (env.ALLOWED_ORIGINS.includes(origin)) {
        callback(null, origin)
        return
      }
      if (env.NODE_ENV !== 'production' && isLocalhostOrigin(origin)) {
        callback(null, origin)
        return
      }
      callback(null, false)
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  const labInMemoryRateLimit = env.LAB_REQUEST_METRICS || env.LAB_INMEMORY_RATE_LIMIT

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_TIME_WINDOW,
    ...(labInMemoryRateLimit ? {} : { redis: redisClient }),
    skipOnError: labInMemoryRateLimit,
    keyGenerator: (req) => {
      const xff = req.headers['x-forwarded-for']
      if (typeof xff === 'string' && xff.length > 0) {
        return xff.split(',')[0]!.trim()
      }
      return req.ip
    },
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
    }),
  })

  app.addHook('onRequest', requestIdHook)
  app.addHook('onRequest', requestLoggerHook)
  app.addHook('onRequest', requestTimingOnRequest)
  app.addHook('onSend', requestTimingOnSend)
  app.addHook('onResponse', requestTimingOnResponse)

  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler(notFoundHandler)

  const prefix = `/api/${env.API_VERSION}`
  await app.register(healthRoutes, { prefix: '/health' })
  await app.register(authRoutes, { prefix: `${prefix}/auth` })
  await app.register(securityPasswordRoutes, { prefix: `${prefix}/security` })
  await app.register(deviceRoutes, { prefix: `${prefix}/devices` })
  await app.register(privacyRoutes, { prefix: `${prefix}/privacy` })
  await app.register(accountDeletionRoutes, { prefix: `${prefix}/account` })
  await app.register(uploadRoutes, { prefix: `${prefix}/upload` })
  await app.register(socialRoutes, { prefix: `${prefix}/social` })
  await app.register(usersRoutes, { prefix: `${prefix}/users` })
  await app.register(settingsRoutes, { prefix: `${prefix}/settings` })
  await app.register(postRoutes, { prefix: `${prefix}/posts` })
  await app.register(conversationRoutes, { prefix: `${prefix}/conversations` })
  await app.register(messageRoutes, { prefix: `${prefix}/messages` })
  await app.register(blockRoutes, { prefix: `${prefix}/blocks` })
  await app.register(reportRoutes, { prefix: `${prefix}/reports` })
  await app.register(reminderRoutes, { prefix: `${prefix}/reminders` })
  await app.register(walletCoinsRoutes, { prefix: `${prefix}/wallet/coins` })
  await app.register(walletPointsRoutes, { prefix: `${prefix}/wallet/points` })
  await app.register(walletLevelsRoutes, { prefix: `${prefix}/wallet/levels` })
  await app.register(callRoutes, { prefix: `${prefix}/call` })
  await app.register(giftRoutes, { prefix: `${prefix}/gifts` })
  await app.register(giftGalleryRoutes, { prefix: `${prefix}/gift-gallery` })
  await app.register(fanRankingRoutes, { prefix: `${prefix}/fan-ranking` })
  await app.register(subscriptionRoutes, { prefix: `${prefix}/subscriptions` })
  await app.register(guardianRoutes, { prefix: `${prefix}/guardian` })
  await app.register(
    async (adminApp) => {
      await registerAdminAuthRoutes(adminApp)
      await adminApp.register(otpDeliveryAdminRoutes)
      await adminApp.register(superHostRoutes)
      await adminApp.register(storeAdminRoutes)
      await adminApp.register(giftAdminRoutes)
      await adminApp.register(adminUserWalletRoutes)
      await adminApp.register(adminTransactionsRoutes)
      await adminApp.register(adminUserModerationRoutes)
      await adminApp.register(adminUserRestrictionRoutes)
      await adminApp.register(userAdminRoutes)
      await adminApp.register(platformMessageAdminRoutes)
      await adminApp.register(pushNotificationAdminRoutes)
      await adminApp.register(ledgerAuditAdminRoutes)
      await adminApp.register(postAdminRoutes)
      await adminApp.register(faceVerificationAdminRoutes)
      await adminApp.register(agencyAdminRoutes, { prefix: '/agency' })
      await adminApp.register(questionnaireAdminRoutes, { prefix: '/questionnaires' })
      await adminApp.register(csaAdminRoutes, { prefix: '/support' })
      await adminApp.register(supportAdminRoutes, { prefix: '/support' })
      await adminApp.register(bannerAdminRoutes)
      await adminApp.register(customGiftAdminRoutes)
      await adminApp.register(adminViewRoutes)
    },
    { prefix: `${prefix}/admin` },
  )
  await app.register(supportRoutes, { prefix: `${prefix}/support` })
  await app.register(storeRoutes, { prefix: `${prefix}/store` })
  await app.register(richTierRoutes, { prefix: `${prefix}/rich-tier` })
  await app.register(vipMembershipRoutes, { prefix: `${prefix}/vip-membership` })
  await app.register(rewardsRoutes, { prefix: `${prefix}/rewards` })
  await app.register(agencyRoutes, { prefix: `${prefix}/agency` })
  await app.register(agencyKycRoutes, { prefix: `${prefix}/agency/kyc` })
  await app.register(agencyCoinsellerRoutes, { prefix: `${prefix}/agency/coinseller` })
  await app.register(coinTradingRoutes, { prefix: `${prefix}/coin-trading` })
  await app.register(paymentMethodRoutes, { prefix: `${prefix}/payment-methods` })
  await app.register(withdrawalRoutes, { prefix: `${prefix}/withdrawal` })
  await app.register(webhooksRoutes, { prefix: `${prefix}/webhooks` })
  await app.register(questionnaireRoutes, { prefix: `${prefix}/questionnaires` })
  await app.register(faceVerificationRoutes, { prefix: `${prefix}/face-verification` })
  await app.register(faceRegistrationRoutes, { prefix: `${prefix}/face-registration` })
  await app.register(livePhotoRoutes, { prefix: `${prefix}/live-photo` })
  await app.register(bannerRoutes, { prefix: `${prefix}/banners` })
  await app.register(customGiftRoutes, { prefix: `${prefix}/custom-gifts` })

  registerRealtimeGateway(app)

  app.addHook('onReady', async () => {
    try {
      await schedulePublicIdPregen()
    } catch (err) {
      rootLogger.error(
        { err },
        '[pregen] failed to register hourly job; worker may still process manual jobs',
      )
    }
    try {
      await publicIdPreGenerationService.runHorizonJob()
    } catch (err) {
      rootLogger.error({ err }, '[pregen] startup horizon run failed; cron will retry')
    }
    if (env.LAB_REQUEST_METRICS) {
      const interval = setInterval(() => requestMetrics.logSummary('periodic'), 60_000)
      interval.unref()
      rootLogger.info('LAB_REQUEST_METRICS enabled — GET /health/metrics for server p50/p95/p99')
    }
  })

  return app
}
