import crypto from 'crypto'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { env } from '../config/env'
import { redisClient, RedisKeys } from '../config/redis'
import { GameSessionStatus } from '@prisma/client'
import { baishunClient, type BaishunCredentials } from '../lib/baishun.client'
import { diamondWalletService } from './diamond-wallet.service'
import { gamePreviewMirrorService, previewMirrorDigest } from './game-preview-mirror.service'
import { rootLogger } from '../utils/rootLogger'

/**
 * How long a cached catalog is served without any background work. Past this the entry
 * is *stale but still served* — see `CATALOG_CACHE_HARD_TTL`.
 */
const CATALOG_CACHE_TTL = 3600
/**
 * How long a stale entry stays usable. Between the two windows a request returns the
 * cached list immediately and kicks off a refresh behind it, so no user ever waits on
 * the provider's API. Only a genuinely cold cache (first boot, or a full day of no
 * traffic) blocks on the live fetch.
 */
const CATALOG_CACHE_HARD_TTL = 86_400
/** Lock TTL for the background refresh, so one crashed refresher cannot wedge the rest. */
const CATALOG_REFRESH_LOCK_TTL = 120
/** Window to actually load the WebView and hit BAISHUN's get_sstoken after launch. */
const LAUNCH_CODE_TTL_SEC = 300

type CachedCatalog = {
  items: GameCatalogItem[]
  /** Epoch ms of the last successful provider fetch; drives the staleness check. */
  refreshedAt: number
}

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

const catalogLogger = rootLogger.child({ module: 'game-catalog' })

async function readCachedCatalog(cacheKey: string): Promise<CachedCatalog | null> {
  let raw: string | null
  try {
    raw = await redisClient.get(cacheKey)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as CachedCatalog).items) &&
      typeof (parsed as CachedCatalog).refreshedAt === 'number'
    ) {
      return parsed as CachedCatalog
    }
    // Entries written before this shape existed were a bare array. Treat one as stale
    // rather than discarding it — it is still a usable catalog, and returning it keeps
    // the deploy from stampeding the provider while the old keys age out.
    if (Array.isArray(parsed)) {
      return { items: parsed as GameCatalogItem[], refreshedAt: 0 }
    }
  } catch {
    /* corrupt entry: fall through to a live fetch */
  }
  return null
}

/**
 * Uploads a local copy of any preview whose mirror is missing, and returns the mirror
 * URL per game id (including ones that were already mirrored).
 *
 * Only games *without* a stored mirror are fetched, so a steady-state sync does no image
 * work at all; a provider-side image change produces a new URL, which fails the equality
 * check below and re-mirrors.
 */
async function mirrorMissingPreviews(
  games: { game_id: number; preview_url?: string | null }[],
  entries: { gameId: number; previewMirrorUrl: string | null }[],
  providerId: string,
): Promise<Map<number, string>> {
  const stored = new Map(entries.map((e) => [e.gameId, e.previewMirrorUrl]))
  const resolved = new Map<number, string>()

  for (const game of games) {
    const sourceUrl = game.preview_url ?? null
    if (!sourceUrl) continue

    const existing = stored.get(game.game_id) ?? null
    // A stored mirror is only good for the source it was made from. The key embeds a
    // hash of that source, so a changed upstream URL no longer matches and re-mirrors.
    if (existing && existing.includes(previewMirrorDigest(sourceUrl))) {
      resolved.set(game.game_id, existing)
      continue
    }

    const mirroredUrl = await gamePreviewMirrorService.mirror({
      providerCode: BAISHUN_PROVIDER_CODE,
      gameId: game.game_id,
      sourceUrl,
    })
    if (!mirroredUrl) continue

    resolved.set(game.game_id, mirroredUrl)
    try {
      await prisma.gameCatalogEntry.update({
        where: { providerId_gameId: { providerId, gameId: game.game_id } },
        data: { previewMirrorUrl: mirroredUrl },
      })
    } catch (err) {
      // The object is uploaded either way; we just re-mirror on the next sync.
      catalogLogger.warn({ err, gameId: game.game_id }, 'failed to persist preview mirror URL')
    }
  }

  return resolved
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

  /**
   * Catalog for the client game grid.
   *
   * Ordering matters here and is the point of the rewrite. The cache is consulted
   * *before* any database work: resolving the provider row is an upsert (a write to the
   * primary), and it used to run on every single request, cache hits included. The cache
   * key is built from env-configured values so a hit now costs one Redis GET and nothing
   * else. A stale-but-usable entry is returned immediately with the refresh moved to the
   * background, so the client grid — which renders nothing until this resolves — is never
   * gated on a cross-border provider call.
   */
  async listCatalog(gameListType: 2 | 3 = 3): Promise<GameCatalogItem[]> {
    const creds = baishunCredsFromEnv()
    if (!creds) {
      throw new AppError(503, 'BAISHUN provider not configured', 'GAME_PROVIDER_NOT_CONFIGURED')
    }

    const cacheKey = RedisKeys.gameCatalog(creds.appChannel, gameListType)
    const cached = await readCachedCatalog(cacheKey)

    if (cached) {
      const ageMs = Date.now() - cached.refreshedAt
      if (ageMs > CATALOG_CACHE_TTL * 1000) {
        // Stale: serve now, refresh behind the response. Failures are logged inside.
        void this.refreshCatalogInBackground(gameListType)
      }
      return cached.items
    }

    return this.syncCatalog(gameListType)
  },

  /**
   * Refreshes a stale catalog without blocking the caller. Guarded by a Redis lock so
   * that a burst of requests arriving on a stale entry produces one provider call, not
   * one per request (and, across processes, one per fleet rather than one per instance).
   */
  async refreshCatalogInBackground(gameListType: 2 | 3): Promise<void> {
    const creds = baishunCredsFromEnv()
    if (!creds) return

    const lockKey = RedisKeys.gameCatalogRefreshLock(creds.appChannel, gameListType)
    try {
      const acquired = await redisClient.set(lockKey, '1', 'EX', CATALOG_REFRESH_LOCK_TTL, 'NX')
      if (acquired !== 'OK') return
    } catch {
      // Redis unavailable: skip the refresh rather than stampeding the provider.
      return
    }

    try {
      await this.syncCatalog(gameListType)
    } catch (err) {
      catalogLogger.warn({ err, gameListType }, 'background catalog refresh failed')
    } finally {
      try {
        await redisClient.del(lockKey)
      } catch {
        /* the TTL will clear it */
      }
    }
  },

  /**
   * Live provider fetch + persistence + cache write. This is the expensive path: a
   * cross-border HTTP call, a provider-row upsert and a transaction of per-game upserts.
   * Reached only on a cold cache or from the background refresher.
   */
  async syncCatalog(gameListType: 2 | 3 = 3): Promise<GameCatalogItem[]> {
    const { provider, creds } = await this.getOrCreateBaishunProvider()
    if (!provider.isActive) return []

    const games = await baishunClient.getGameList(creds, gameListType)

    let entries: { gameId: number; previewMirrorUrl: string | null }[] = []
    if (games.length > 0) {
      entries = await prisma.$transaction(
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
            select: { gameId: true, previewMirrorUrl: true },
          }),
        ),
      )
    }

    // Mirror any preview we do not have a local copy of yet. This is awaited, so the
    // very first sync pays for it (~0.5s per image) — but the result is persisted on the
    // catalog row, so every later sync finds the mirrors already there and does no image
    // work at all. Since this path only runs on a cold cache or from the background
    // refresher, no user-facing request pays it twice.
    const mirrored = await mirrorMissingPreviews(games, entries, provider.id)

    const result: GameCatalogItem[] = games.map((g) => ({
      gameId: g.game_id,
      providerCode: BAISHUN_PROVIDER_CODE,
      name: g.name,
      previewUrl: mirrored.get(g.game_id) ?? g.preview_url ?? null,
      downloadUrl: g.download_url ?? null,
      version: g.game_version ?? null,
      orientation: g.game_orientation ?? null,
      safeHeight: g.safe_height ?? null,
    }))

    try {
      const payload: CachedCatalog = { items: result, refreshedAt: Date.now() }
      await redisClient.set(
        RedisKeys.gameCatalog(creds.appChannel, gameListType),
        JSON.stringify(payload),
        'EX',
        CATALOG_CACHE_HARD_TTL,
      )
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
      gsp: env.GAME_PROVIDER_BAISHUN_GSP,
    }
  },
}
