import crypto from 'crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../config/env'
import { redisClient, RedisKeys } from '../config/redis'
import { AppError } from './errorHandler'

const SIGNATURE_WINDOW_SEC = 15
const NONCE_TTL_SEC = 20

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex')
}

/**
 * Verifies BAISHUN's inbound merchant-server call signature (§3 of their integration
 * doc): `signature = md5(signature_nonce + appKey + timestamp)`, request valid for 15s,
 * and `signature_nonce` must not repeat within that window (replay guard — BAISHUN's own
 * spec requires this; unlike `epay.client.ts`'s webhook, which has no nonce at all).
 */
export async function verifyBaishunSignature(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const appKey = env.GAME_PROVIDER_BAISHUN_APP_KEY
  if (!appKey) {
    throw new AppError(503, 'BAISHUN provider not configured', 'GAME_PROVIDER_NOT_CONFIGURED')
  }

  const body = (request.body ?? {}) as Record<string, unknown>
  const nonce = typeof body.signature_nonce === 'string' ? body.signature_nonce : ''
  const timestamp =
    typeof body.timestamp === 'number' ? body.timestamp : Number(body.timestamp ?? NaN)
  const signature = typeof body.signature === 'string' ? body.signature : ''

  if (!nonce || !signature || !Number.isFinite(timestamp)) {
    throw new AppError(400, 'Missing signature fields', 'INVALID_REQUEST')
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - timestamp) > SIGNATURE_WINDOW_SEC) {
    throw new AppError(401, 'Request timestamp expired', 'GAME_TIMESTAMP_EXPIRED')
  }

  const expected = md5(`${nonce}${appKey}${timestamp}`)
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signature, 'utf8')
  const valid =
    expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)
  if (!valid) {
    throw new AppError(401, 'Invalid signature', 'INVALID_SIGNATURE')
  }

  const nonceKey = RedisKeys.gameProviderNonce('BAISHUN', nonce)
  const claimed = await redisClient.set(nonceKey, '1', 'EX', NONCE_TTL_SEC, 'NX')
  if (claimed !== 'OK') {
    throw new AppError(409, 'Duplicate request (nonce replay)', 'GAME_SIGNATURE_NONCE_REPLAY')
  }
}
