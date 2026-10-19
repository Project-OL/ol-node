import { createHash, randomBytes } from 'crypto'
import bcrypt from 'bcrypt'
import { GoogleAuth } from 'google-auth-library'
import { prisma } from '../config/database'
import { env } from '../config/env'
import { redisClient } from '../config/redis'
import { notifySuperAdmins } from '../jobs/gcp-infra-monitor.job'
import { AppError } from '../middlewares/errorHandler'
import type { InfraCapacityChange } from '../models/infra-capacity.schemas'
import { rootLogger } from '../utils/rootLogger'

/**
 * INF-23: capacity changes from the admin page (SUPER_ADMIN only).
 *
 * The change itself is made by the separate Cloud Run service `ol-scaler` (OL_SCALER_URL), which
 * holds the GCP permissions and the hard caps; this service only authenticates the human:
 * - an ops password (table admin_ops_credentials, set by the CLI on the VM, never via the API),
 * - exchanged for a single-use step-up token (5 min),
 * - 5 wrong passwords lock the ops password for 15 min,
 * - one change per 10 min (global cooldown),
 * - every change is audited and emailed to all SUPER_ADMINs (+ GCP_INFRA_ALERT_EXTRA_EMAILS).
 * The main VM (single Live-server) is not controllable here at all: the scaler only knows the API
 * group and Redis.
 */
const log = rootLogger.child({ module: 'infra-capacity' })

export const STEP_UP_TTL_SEC = 300
export const STEP_UP_MAX_FAILS = 5
export const STEP_UP_LOCK_SEC = 900
export const CHANGE_COOLDOWN_SEC = 600

export const opsKeys = {
  stepUp: (adminId: string, tokenHash: string) => `ops:stepup:${adminId}:${tokenHash}`,
  fails: (adminId: string) => `ops:stepup:fail:${adminId}`,
  lock: (adminId: string) => `ops:stepup:lock:${adminId}`,
  cooldown: () => 'ops:capacity:cooldown',
}

/** Suggested API-group profiles for the page (the scaler's caps still apply). */
export const API_PROFILES = [
  { id: 'normal', label: 'Normal', minReplicas: 1, maxReplicas: 3 },
  { id: 'event', label: 'Event', minReplicas: 2, maxReplicas: 6 },
  { id: 'max', label: 'Max', minReplicas: 4, maxReplicas: 6 },
] as const

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

let auth: GoogleAuth | null = null
async function scaler<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const base = env.OL_SCALER_URL
  if (!base)
    throw new AppError(503, 'Capacity control is not configured', 'CAPACITY_NOT_CONFIGURED')
  auth ??= new GoogleAuth()
  const client = await auth.getIdTokenClient(base)
  try {
    const res = await client.request<T>({
      url: `${base.replace(/\/+$/, '')}${path}`,
      method,
      data: body,
      timeout: 20_000,
    })
    return res.data
  } catch (err) {
    const e = err as { response?: { status?: number; data?: { error?: string } }; message?: string }
    const status = e.response?.status ?? 502
    const message = e.response?.data?.error ?? e.message ?? 'scaler call failed'
    if (status === 400) throw new AppError(400, message, 'CAPACITY_REFUSED')
    log.error({ status, message, path }, 'ol-scaler call failed')
    throw new AppError(502, `Capacity service error: ${message}`, 'CAPACITY_SCALER_ERROR')
  }
}

type ScalerStatus = {
  api: {
    autoscaler: string
    targetSize: number
    isStable: boolean
    minReplicas: number
    maxReplicas: number
    cpuTarget: number
    caps: { minMax: number; maxMax: number }
  }
  redis: {
    name: string
    tier: string
    state: string
    sizeGb: number
    usedRatio: number | null
    usedGb: number | null
    allowedSizes: number[]
  }
}

export const infraCapacityService = {
  isConfigured: () => Boolean(env.OL_SCALER_URL),

  async getCapacity(adminId: string) {
    const [status, cooldownTtl, hasOpsPassword, recent] = await Promise.all([
      this.isConfigured() ? scaler<ScalerStatus>('GET', '/status') : Promise.resolve(null),
      redisClient.ttl(opsKeys.cooldown()),
      prisma.adminOpsCredential.findUnique({ where: { adminId }, select: { adminId: true } }),
      prisma.auditLog.findMany({
        where: { actionType: 'ADMIN_INFRA_CAPACITY_CHANGED' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { createdAt: true, adminUserId: true, actionStatus: true, actionDetails: true },
      }),
    ])
    return {
      configured: this.isConfigured(),
      hasOpsPassword: Boolean(hasOpsPassword),
      cooldownSeconds: cooldownTtl > 0 ? cooldownTtl : 0,
      profiles: API_PROFILES,
      api: status?.api ?? null,
      redis: status?.redis ?? null,
      recentChanges: recent,
    }
  },

  async stepUp(adminId: string, opsPassword: string) {
    if (await redisClient.exists(opsKeys.lock(adminId))) {
      throw new AppError(
        429,
        'Too many wrong ops passwords. Try again in 15 minutes.',
        'OPS_LOCKED',
      )
    }
    const cred = await prisma.adminOpsCredential.findUnique({ where: { adminId } })
    if (!cred) {
      throw new AppError(403, 'No ops password is set for this admin', 'OPS_PASSWORD_NOT_SET')
    }
    const ok = await bcrypt.compare(opsPassword, cred.passwordHash)
    if (!ok) {
      const fails = await redisClient.incr(opsKeys.fails(adminId))
      if (fails === 1) await redisClient.expire(opsKeys.fails(adminId), STEP_UP_LOCK_SEC)
      if (fails >= STEP_UP_MAX_FAILS) {
        await redisClient.set(opsKeys.lock(adminId), '1', 'EX', STEP_UP_LOCK_SEC)
        await redisClient.del(opsKeys.fails(adminId))
      }
      throw new AppError(401, 'Wrong ops password', 'OPS_PASSWORD_INVALID')
    }
    await redisClient.del(opsKeys.fails(adminId))
    const token = randomBytes(32).toString('hex')
    await redisClient.set(opsKeys.stepUp(adminId, sha256(token)), '1', 'EX', STEP_UP_TTL_SEC)
    return { stepUpToken: token, expiresInSec: STEP_UP_TTL_SEC }
  },

  async change(adminId: string, body: InfraCapacityChange) {
    // Single use: consumed whether or not the change goes through.
    const used = await redisClient.getdel(opsKeys.stepUp(adminId, sha256(body.stepUpToken)))
    if (!used) {
      throw new AppError(
        401,
        'Step-up expired or already used. Enter the ops password again.',
        'OPS_STEPUP_REQUIRED',
      )
    }
    const claimed = await redisClient.set(
      opsKeys.cooldown(),
      adminId,
      'EX',
      CHANGE_COOLDOWN_SEC,
      'NX',
    )
    if (!claimed) {
      const ttl = await redisClient.ttl(opsKeys.cooldown())
      throw new AppError(
        429,
        `Another capacity change was made recently. Try again in ${Math.max(ttl, 1)} s.`,
        'CAPACITY_COOLDOWN',
      )
    }
    const request =
      body.kind === 'api'
        ? { kind: 'api' as const, minReplicas: body.minReplicas, maxReplicas: body.maxReplicas }
        : { kind: 'redis' as const, sizeGb: body.sizeGb }
    try {
      const result = await scaler<{
        before: Record<string, number>
        operation: { kind: string; ref: string }
      }>('POST', '/scale', request)
      return { request, reason: body.reason ?? null, ...result }
    } catch (err) {
      await redisClient.del(opsKeys.cooldown()) // a refused/failed change doesn't use up the cooldown
      throw err
    }
  },

  async operation(ref: string) {
    return scaler<{ done: boolean; error: string | null }>(
      'GET',
      `/operations?ref=${encodeURIComponent(ref)}`,
    )
  },

  /** Email every SUPER_ADMIN about a change (fire-and-forget from the route). */
  async notifyChange(adminId: string, summary: string) {
    const admin = await prisma.systemAdmin.findUnique({
      where: { id: adminId },
      select: { email: true },
    })
    const adminEmail = admin?.email ?? adminId
    const subject = `[Offoo prod] Capacity changed: ${summary}`
    const text = `${adminEmail} changed production capacity: ${summary}.\n\nSee the admin capacity page for the operation status and history.`
    const html = `<p><b>${adminEmail}</b> changed production capacity: <b>${summary}</b>.</p><p>See the admin capacity page for the operation status and history.</p>`
    await notifySuperAdmins(subject, text, html)
  },
}
