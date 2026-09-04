import crypto from 'crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { verifyBaishunSignature } from '../../middlewares/gameProviderWebhookAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { baishunSessionService } from '../../services/baishunSession.service'
import {
  BaishunGetSsTokenSchema,
  BaishunGetUserInfoSchema,
  BaishunUpdateSsTokenSchema,
  BaishunChangeBalanceSchema,
} from '../../models/baishun-webhook.schemas'
import {
  BAISHUN_ERROR_CODE_MAP,
  BAISHUN_DEFAULT_ERROR_CODE,
} from '../../config/baishun-error-codes'

function uniqueId(): string {
  return crypto.randomUUID()
}

function sendBaishunSuccess(reply: FastifyReply, data: unknown, extra?: Record<string, unknown>) {
  return reply.status(200).send({
    code: 0,
    message: 'succeed',
    unique_id: uniqueId(),
    data,
    ...extra,
  })
}

/**
 * Inbound merchant-server endpoints BAISHUN calls INTO us (§3 of their integration doc).
 * Speaks their envelope end-to-end: HTTP 200 always, `data.code` (0 = success, else their
 * numeric table) carries the outcome — so this plugin gets its own `setErrorHandler`
 * (Fastify plugin encapsulation scopes it to just this route group) instead of the
 * app-wide `errorHandler`, which would otherwise respond in our own JSON shape.
 */
export async function gameWebhooksRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const code = error.code ? (BAISHUN_ERROR_CODE_MAP[error.code] ?? BAISHUN_DEFAULT_ERROR_CODE) : BAISHUN_DEFAULT_ERROR_CODE
      return reply.status(200).send({ code, message: error.message, unique_id: uniqueId(), data: {} })
    }
    request.log.error({ err: error }, 'Unhandled error in game-webhooks route')
    return reply
      .status(200)
      .send({ code: BAISHUN_DEFAULT_ERROR_CODE, message: 'Internal error', unique_id: uniqueId(), data: {} })
  })

  app.post(
    '/baishun/v1/api/get_sstoken',
    { preHandler: [verifyBaishunSignature] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = BaishunGetSsTokenSchema.parse(request.body)
      const result = await baishunSessionService.getSsToken({
        userId: body.user_id,
        code: body.code,
      })
      return sendBaishunSuccess(
        reply,
        { ss_token: result.ssToken, expire_date: result.expireDateMs },
        {
          user_info: {
            user_id: result.userInfo.userId,
            user_name: result.userInfo.userName,
            user_avatar: result.userInfo.userAvatar,
            balance: result.userInfo.balance,
          },
        },
      )
    },
  )

  app.post(
    '/baishun/v1/api/get_user_info',
    { preHandler: [verifyBaishunSignature] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = BaishunGetUserInfoSchema.parse(request.body)
      const result = await baishunSessionService.getUserInfo({ ssToken: body.ss_token })
      return sendBaishunSuccess(reply, {
        user_id: result.userId,
        user_name: result.userName,
        user_avatar: result.userAvatar,
        balance: result.balance,
      })
    },
  )

  app.post(
    '/baishun/v1/api/update_sstoken',
    { preHandler: [verifyBaishunSignature] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = BaishunUpdateSsTokenSchema.parse(request.body)
      const result = await baishunSessionService.updateSsToken({ ssToken: body.ss_token })
      return sendBaishunSuccess(reply, { ss_token: result.ssToken, expire_date: result.expireDateMs })
    },
  )

  app.post(
    '/baishun/v1/api/change_balance',
    { preHandler: [verifyBaishunSignature] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = BaishunChangeBalanceSchema.parse(request.body)
      const result = await baishunSessionService.changeBalance({
        ssToken: body.ss_token,
        currencyDiff: body.currency_diff,
        diffMsg: body.diff_msg,
        gameId: body.game_id,
        roomId: body.room_id,
        orderId: body.order_id,
      })
      return sendBaishunSuccess(reply, { currency_balance: Number(result.currencyBalance) })
    },
  )
}
