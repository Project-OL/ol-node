import crypto from 'crypto'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { env } from '../config/env'
import { redisClient, RedisKeys } from '../config/redis'
import { GameSessionStatus } from '@prisma/client'
import { baishunClient, type BaishunCredentials } from '../lib/baishun.client'
import { diamondWalletService } from './diamond-wallet.service'

const CATALOG_CACHE_TTL = 3600
/** Window to actually load the WebView and hit BAISHUN's get_sstoken after launch. */
const LAUNCH_CODE_TTL_SEC = 300

export const BAISHUN_PROVIDER_CODE = 'BAISHUN'

export type GameCatalogItem = {
  gameId: number
  providerCode: string
  name: string
  previewUrl: string | null
  downloadUrl: string | null
  version: string | null
  orientation: number | null
  safeHeight: number | null
}

function baishunCredsFromEnv(): BaishunCredentials | null {
  const baseUrl = env.GAME_PROVIDER_BAISHUN_BASE_URL
  const appId = env.GAME_PROVIDER_BAISHUN_APP_ID
  const appChannel = env.GAME_PROVIDER_BAISHUN_APP_CHANNEL
  const appKey = env.GAME_PROVIDER_BAISHUN_APP_KEY
  if (!baseUrl || !appId || !appChannel || !appKey) return null
  return { baseUrl, appId, appChannel, appKey }
}

/**
 * Generic game-provider orchestration. Only BAISHUN is wired today, but catalog/launch
 * are provider-agnostic — a second provider adds a new `*Credentials` resolver + client
 * (mirroring `baishun.client.ts`) and a branch here, not a rewrite of this service or of
 * `games.routes.ts`.
 */
export const gameProviderService = {
  /**
   * Ensures a `GameProvider` row exists for the env-configured BAISHUN credentials.
   * Only non-secret fields are persisted (appId/appChannel/baseUrl) — the appKey stays
   * env-only, never written to the DB or logged.
   */
  async getOrCreateBaishunProvider(): Promise<{
    provider: Awaited<ReturnType<typeof prisma.gameProvider.upsert>>
    creds: BaishunCredentials
  }> {
    const creds = baishunCredsFromEnv()
    if (!creds) {
      throw new AppError(503, 'BAISHUN provider not configured', 'GAME_PROVIDER_NOT_CONFIGURED')
    }
    const provider = await prisma.gameProvider.upsert({
      where: { code_channel: { code: BAISHUN_PROVIDER_CODE, channel: creds.appChannel } },
      create: {
        code: BAISHUN_PROVIDER_CODE,
        channel: creds.appChannel,
        appId: creds.appId,
        appChannel: creds.appChannel,
        baseUrl: creds.baseUrl,
      },
      update: { appId: creds.appId, baseUrl: creds.baseUrl },
    })
    return { provider, creds }
  },

  async listCatalog(gameListType: 2 | 3 = 3): Promise<GameCatalogItem[]> {
    const { provider, creds } = await this.getOrCreateBaishunProvider()
    if (!provider.isActive) return []

    const cacheKey = RedisKeys.gameCatalog(provider.id)
    try {
      const cached = await redisClient.get(cacheKey)
      if (cached) return JSON.parse(cached) as GameCatalogItem[]
    } catch {
      /* fall through to live fetch */
    }

    const games = await baishunClient.getGameList(creds, gameListType)

    if (games.length > 0) {
      await prisma.$transaction(
        games.map((g) =>
          prisma.gameCatalogEntry.upsert({
            where: { providerId_gameId: { providerId: provider.id, gameId: g.game_id } },
            create: {
              providerId: provider.id,
              gameId: g.game_id,
              name: g.name,
              previewUrl: g.preview_url,
              downloadUrl: g.download_url,
              gameVersion: g.game_version,
              gameMode: g.game_mode,
              orientation: g.game_orientation,
              safeHeight: g.safe_height,
              venueLevel: g.venue_level,
            },
            update: {
              name: g.name,
              previewUrl: g.preview_url,
              downloadUrl: g.download_url,
              gameVersion: g.game_version,
              gameMode: g.game_mode,
              orientation: g.game_orientation,
              safeHeight: g.safe_height,
              venueLevel: g.venue_level,
              syncedAt: new Date(),
            },
          }),
        ),
      )
    }

    const result: GameCatalogItem[] = games.map((g) => ({
      gameId: g.game_id,
      providerCode: BAISHUN_PROVIDER_CODE,
      name: g.name,
      previewUrl: g.preview_url ?? null,
      downloadUrl: g.download_url ?? null,
      version: g.game_version ?? null,
      orientation: g.game_orientation ?? null,
      safeHeight: g.safe_height ?? null,
    }))
    try {
      await redisClient.set(cacheKey, JSON.stringify(result), 'EX', CATALOG_CACHE_TTL)
    } catch {
      /* ignore cache write failure */
    }
    return result
  },

  /** Issues a one-time launch `code` the app's WebView feeds into BAISHUN's `getConfig()`. */
  async launchGame(
    userId: string,
    params: { gameId: number; roomId?: string; gameMode?: '2' | '3'; language?: string },
  ) {
    const { provider, creds } = await this.getOrCreateBaishunProvider()
    if (!provider.isActive) {
      throw new AppError(503, 'Game provider inactive', 'GAME_PROVIDER_INACTIVE')
    }

    const user = await prismaRead.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    // Ensure the diamond wallet exists (0 balance is fine — BAISHUN reads the live figure
    // via get_sstoken/get_user_info, not this response).
    await diamondWalletService.getBalance(userId)

    const code = crypto.randomBytes(24).toString('base64url')
    await prisma.gameSession.create({
      data: {
        userId,
        providerId: provider.id,
        gameId: params.gameId,
        code,
        roomId: params.roomId ?? null,
        status: GameSessionStatus.ISSUED,
      },
    })
    try {
      await redisClient.set(RedisKeys.gameLaunchCode(code), userId, 'EX', LAUNCH_CODE_TTL_SEC)
    } catch {
      // Postgres row is the source of truth for get_sstoken; Redis is only a fast
      // pre-check, so a cache-write failure here is not fatal.
    }

    return {
      appChannel: creds.appChannel,
      appId: creds.appId,
      userId,
      code,
      roomId: params.roomId ?? '',
      gameMode: params.gameMode ?? '3',
      language: params.language ?? '2',
      gameConfig: {
        sceneMode: 0,
        currencyIcon: env.GAME_DIAMOND_ICON_URL ?? '',
      },
      gsp: 101,
    }
  },
}
