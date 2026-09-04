import crypto from 'crypto'
import axios, { type AxiosInstance } from 'axios'
import { AppError } from '../middlewares/errorHandler'
import { gameProviderCircuitBreaker } from '../utils/circuitBreaker'

/**
 * Outbound client for BAISHUN's game-backend APIs (§4 of their integration doc:
 * one_game_info, gamelist, balance_info). Signing scheme is BAISHUN-specific —
 * `signature = md5(signature_nonce + appKey + timestamp)` — and not shared with
 * `epay.client.ts`'s HMAC-SHA256 (only the retry/circuit-breaker shape is mirrored).
 *
 * This client is intentionally provider-specific: `gameProvider.service.ts` is the
 * generic abstraction other providers plug into; this file only ever talks BAISHUN.
 */

export type BaishunCredentials = {
  baseUrl: string
  appId: string
  appChannel: string
  appKey: string
}

export type BaishunGameInfo = {
  game_id: number
  name: string
  preview_url: string
  game_version: string
  download_url: string
  game_mode: number[]
  game_orientation: number
  safe_height: number
  venue_level: number[]
}

function signature(appKey: string, nonce: string, timestampSec: number): string {
  return crypto
    .createHash('md5')
    .update(`${nonce}${appKey}${timestampSec}`)
    .digest('hex')
}

function commonParams(appKey: string): { signature_nonce: string; timestamp: number; signature: string } {
  const nonce = crypto.randomBytes(8).toString('hex')
  const timestamp = Math.floor(Date.now() / 1000)
  return { signature_nonce: nonce, timestamp, signature: signature(appKey, nonce, timestamp) }
}

function clientFor(creds: BaishunCredentials): AxiosInstance {
  return axios.create({
    baseURL: creds.baseUrl.startsWith('http') ? creds.baseUrl : `https://${creds.baseUrl}`,
    timeout: 15_000,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  if (gameProviderCircuitBreaker.shouldSkip()) {
    throw new AppError(502, 'Game provider temporarily unavailable', 'GAME_PROVIDER_CIRCUIT_OPEN')
  }
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn()
      gameProviderCircuitBreaker.recordSuccess()
      return result
    } catch (err) {
      lastErr = err
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status == null || status < 500 || attempt === retries) break
      const delay = Math.pow(2, attempt) * 300
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  gameProviderCircuitBreaker.recordFailure()
  throw new AppError(502, 'Game provider gateway error', 'GAME_PROVIDER_GATEWAY_ERROR', {
    cause: String(lastErr),
  })
}

/** Throws on any non-zero BAISHUN `code` — their envelope, not ours. */
function unwrap<T>(data: { code: number; message?: string; data: T }): T {
  if (data.code !== 0) {
    throw new AppError(502, data.message ?? 'Game provider error', 'GAME_PROVIDER_ERROR', {
      code: data.code,
    })
  }
  return data.data
}

export const baishunClient = {
  async getGameList(
    creds: BaishunCredentials,
    gameListType: 2 | 3,
  ): Promise<BaishunGameInfo[]> {
    return withRetry(async () => {
      const client = clientFor(creds)
      const { data } = await client.post('/v1/api/gamelist', {
        game_list_type: gameListType,
        app_channel: creds.appChannel,
        app_id: Number(creds.appId),
        ...commonParams(creds.appKey),
      })
      return unwrap<BaishunGameInfo[]>(data)
    })
  },

  async getOneGameInfo(creds: BaishunCredentials, gameId: number): Promise<BaishunGameInfo> {
    return withRetry(async () => {
      const client = clientFor(creds)
      const { data } = await client.post('/v1/api/one_game_info', {
        app_channel: creds.appChannel,
        app_id: Number(creds.appId),
        game_id: gameId,
        ...commonParams(creds.appKey),
      })
      return unwrap<BaishunGameInfo>(data)
    })
  },

  /** Buy-in mode games only (§4.3). Not called by the default flow. */
  async getBalanceInfo(
    creds: BaishunCredentials,
    userId: string,
  ): Promise<{ cur_coin: number }> {
    return withRetry(async () => {
      const client = clientFor(creds)
      const { data } = await client.post('/v2/api/balance_info', {
        user_id: userId,
        app_id: Number(creds.appId),
        app_channel: creds.appChannel,
        ...commonParams(creds.appKey),
      })
      return unwrap<{ cur_coin: number }>(data)
    })
  },
}
