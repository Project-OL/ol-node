import { describe, it, expect, vi, beforeEach } from 'vitest'
import bcrypt from 'bcrypt'

// Minimal in-memory Redis with the commands the service uses.
const store = new Map<string, { v: string; exp?: number }>()
const live = (k: string) => {
  const e = store.get(k)
  if (e && e.exp && e.exp < Date.now()) store.delete(k)
  return store.get(k)
}
const redis = {
  exists: vi.fn(async (k: string) => (live(k) ? 1 : 0)),
  incr: vi.fn(async (k: string) => {
    const n = Number(live(k)?.v ?? 0) + 1
    store.set(k, { v: String(n), exp: store.get(k)?.exp })
    return n
  }),
  expire: vi.fn(async (k: string, s: number) => {
    const e = live(k)
    if (e) e.exp = Date.now() + s * 1000
    return 1
  }),
  set: vi.fn(async (k: string, v: string, ...args: (string | number)[]) => {
    if (args.includes('NX') && live(k)) return null
    const ex = args[args.indexOf('EX') + 1] as number
    store.set(k, { v, exp: Date.now() + ex * 1000 })
    return 'OK'
  }),
  del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  getdel: vi.fn(async (k: string) => {
    const e = live(k)
    store.delete(k)
    return e?.v ?? null
  }),
  ttl: vi.fn(async (k: string) => {
    const e = live(k)
    return e?.exp ? Math.ceil((e.exp - Date.now()) / 1000) : -2
  }),
}
const env: { OL_SCALER_URL?: string } = { OL_SCALER_URL: 'https://ol-scaler.example.run.app' }
const scalerRequest = vi.fn()
let passwordHash = ''

vi.mock('../../src/utils/rootLogger', () => ({
  rootLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('../../src/config/redis', () => ({ redisClient: redis }))
vi.mock('../../src/config/env', () => ({ env }))
vi.mock('../../src/jobs/gcp-infra-monitor.job', () => ({ notifySuperAdmins: vi.fn() }))
vi.mock('../../src/config/database', () => ({
  prisma: {
    adminOpsCredential: { findUnique: vi.fn(async () => (passwordHash ? { adminId: 'a1', passwordHash } : null)) },
    auditLog: { findMany: vi.fn(async () => []) },
    systemAdmin: { findUnique: vi.fn(async () => ({ email: 'boss@example.com' })) },
  },
}))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getIdTokenClient() {
      return { request: scalerRequest }
    }
  },
}))

const { infraCapacityService, STEP_UP_MAX_FAILS } = await import('../../src/services/infra-capacity.service')

describe('INF-23 capacity control', () => {
  beforeEach(async () => {
    store.clear()
    scalerRequest.mockReset()
    env.OL_SCALER_URL = 'https://ol-scaler.example.run.app'
    passwordHash = await bcrypt.hash('correct horse battery staple', 4)
  })

  it('no ops password set -> 403', async () => {
    passwordHash = ''
    await expect(infraCapacityService.stepUp('a1', 'x')).rejects.toMatchObject({ code: 'OPS_PASSWORD_NOT_SET' })
  })

  it('wrong passwords lock the step-up after the limit', async () => {
    for (let i = 0; i < STEP_UP_MAX_FAILS; i++) {
      await expect(infraCapacityService.stepUp('a1', 'wrong')).rejects.toMatchObject({ code: 'OPS_PASSWORD_INVALID' })
    }
    // Locked: even the right password is refused now.
    await expect(infraCapacityService.stepUp('a1', 'correct horse battery staple')).rejects.toMatchObject({ code: 'OPS_LOCKED' })
  })

  it('a step-up token works once, and the cooldown blocks a second change', async () => {
    scalerRequest.mockResolvedValue({ data: { before: { minReplicas: 1, maxReplicas: 3 }, operation: { kind: 'compute', ref: 'op-1' } } })
    const { stepUpToken } = await infraCapacityService.stepUp('a1', 'correct horse battery staple')
    const out = await infraCapacityService.change('a1', { kind: 'api', minReplicas: 2, maxReplicas: 6, stepUpToken })
    expect(out.operation.ref).toBe('op-1')
    expect(scalerRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', data: { kind: 'api', minReplicas: 2, maxReplicas: 6 } }),
    )
    // Same token again: refused (single use).
    await expect(
      infraCapacityService.change('a1', { kind: 'api', minReplicas: 1, maxReplicas: 3, stepUpToken }),
    ).rejects.toMatchObject({ code: 'OPS_STEPUP_REQUIRED' })
    // Fresh token, but inside the cooldown: refused.
    const second = await infraCapacityService.stepUp('a1', 'correct horse battery staple')
    await expect(
      infraCapacityService.change('a1', { kind: 'api', minReplicas: 1, maxReplicas: 3, stepUpToken: second.stepUpToken }),
    ).rejects.toMatchObject({ code: 'CAPACITY_COOLDOWN' })
  })

  it('a change the scaler refuses does not use up the cooldown', async () => {
    scalerRequest.mockRejectedValueOnce({ response: { status: 400, data: { error: 'maxReplicas is capped at 6' } } })
    const t1 = await infraCapacityService.stepUp('a1', 'correct horse battery staple')
    await expect(
      infraCapacityService.change('a1', { kind: 'api', minReplicas: 1, maxReplicas: 8, stepUpToken: t1.stepUpToken }),
    ).rejects.toMatchObject({ code: 'CAPACITY_REFUSED', statusCode: 400 })
    scalerRequest.mockResolvedValueOnce({ data: { before: { sizeGb: 2 }, operation: { kind: 'redis', ref: 'projects/p/op' } } })
    const t2 = await infraCapacityService.stepUp('a1', 'correct horse battery staple')
    const ok = await infraCapacityService.change('a1', { kind: 'redis', sizeGb: 3, stepUpToken: t2.stepUpToken })
    expect(ok.request).toEqual({ kind: 'redis', sizeGb: 3 })
  })

  it('not configured -> read-only page, changes refused with 503', async () => {
    env.OL_SCALER_URL = undefined
    const cap = await infraCapacityService.getCapacity('a1')
    expect(cap.configured).toBe(false)
    expect(cap.api).toBeNull()
    const { stepUpToken } = await infraCapacityService.stepUp('a1', 'correct horse battery staple')
    await expect(
      infraCapacityService.change('a1', { kind: 'api', minReplicas: 1, maxReplicas: 3, stepUpToken }),
    ).rejects.toMatchObject({ code: 'CAPACITY_NOT_CONFIGURED' })
  })
})
