import { redisClient, RedisKeys, ADMIN_VIEW_ACCESS_TTL } from '../config/redis'
import { adminViewRepository } from '../repositories/adminView.repository'
import { systemAdminRepository } from '../repositories/systemAdmin.repository'
import { AppError } from '../middlewares/errorHandler'
import type { UpsertViewInput } from '../models/admin-view.schemas'
import type { AdminView } from '@prisma/client'

/**
 * Param NAMES in endpoint declarations don't matter — "GET /admin/users/:id"
 * and the registered route "/admin/users/:userId" must compare equal. Every
 * `:param` segment collapses to `:p`.
 */
export function normalizeAdminEndpoint(endpoint: string): string {
  const [method, path] = endpoint.trim().split(/\s+/, 2)
  if (!method || !path) return endpoint.trim()
  const normalizedPath = path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? ':p' : seg))
    .join('/')
    .replace(/\/+$/, '')
  return `${method.toUpperCase()} ${normalizedPath}`
}

/** Per-request permission snapshot for one admin. */
export interface AdminViewAccess {
  /** True when the admin has >=1 assigned view — endpoint gating applies. */
  restricted: boolean
  /** Normalized "METHOD /admin/path" keys granted by the assigned views. */
  endpoints: Set<string>
}

interface CachedAccess {
  restricted: boolean
  endpoints: string[]
}

function toViewDto(view: AdminView & { _count?: { assignments: number } }) {
  return {
    name: view.name,
    endpoints: view.endpoints,
    ...(view._count ? { assignedAdminCount: view._count.assignments } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  }
}

async function bustAccessCache(adminIds: string[]): Promise<void> {
  if (adminIds.length === 0) return
  try {
    await redisClient.del(...adminIds.map((id) => RedisKeys.adminViewAccess(id)))
  } catch {
    // Cache bust is best-effort; TTL (120s) bounds staleness.
  }
}

export const adminViewService = {
  normalizeAdminEndpoint,

  async listViews() {
    const views = await adminViewRepository.findAll()
    return { views: views.map(toViewDto) }
  },

  /**
   * Create a view, or extend an existing one — the endpoint list is the UNION
   * of what's stored and what's submitted (never removes; use replace for that).
   */
  async upsertView(input: UpsertViewInput, createdByAdminId: string) {
    const existing = await adminViewRepository.findByName(input.name)
    if (!existing) {
      const created = await adminViewRepository.create({
        name: input.name,
        endpoints: dedupe(input.endpoints),
        createdByAdminId,
      })
      return { view: toViewDto(created), created: true }
    }

    const merged = dedupe([...existing.endpoints, ...input.endpoints])
    const updated = await adminViewRepository.updateEndpoints(existing.id, merged)
    await bustAccessCache(await adminViewRepository.findAssignedAdminIds(existing.id))
    return { view: toViewDto(updated), created: false }
  },

  /** Replace a view's endpoint list entirely (removal path for wrong entries). */
  async replaceViewEndpoints(viewName: string, endpoints: string[]) {
    const existing = await adminViewRepository.findByName(viewName)
    if (!existing) {
      throw new AppError(404, 'View not found', 'ADMIN_VIEW_NOT_FOUND')
    }
    const updated = await adminViewRepository.updateEndpoints(existing.id, dedupe(endpoints))
    await bustAccessCache(await adminViewRepository.findAssignedAdminIds(existing.id))
    return { view: toViewDto(updated) }
  },

  /** Views assigned to one admin (SUPER_ADMIN callers of /views/me get all views). */
  async getAssignedViews(adminId: string) {
    const views = await adminViewRepository.findAssignedViews(adminId)
    return { views: views.map((v) => ({ name: v.name, endpoints: v.endpoints })) }
  },

  /**
   * Replace the target admin's assigned view set. Empty array clears all
   * assignments (admin falls back to plain role-based access).
   */
  async assignViews(targetAdminId: string, viewNames: string[], assignedByAdminId: string) {
    const admin = await systemAdminRepository.findById(targetAdminId)
    if (!admin) {
      throw new AppError(404, 'Admin not found', 'ADMIN_NOT_FOUND')
    }
    if (admin.role === 'SUPER_ADMIN') {
      throw new AppError(400, 'SUPER_ADMIN always has full access', 'ADMIN_VIEW_SUPER_ADMIN')
    }

    const names = dedupe(viewNames)
    const views = await adminViewRepository.findByNames(names)
    if (views.length !== names.length) {
      const found = new Set(views.map((v) => v.name))
      const missing = names.filter((n) => !found.has(n))
      throw new AppError(404, `Unknown views: ${missing.join(', ')}`, 'ADMIN_VIEW_NOT_FOUND', {
        missing,
      })
    }

    await adminViewRepository.replaceAssignments(
      targetAdminId,
      views.map((v) => v.id),
      assignedByAdminId,
    )
    await bustAccessCache([targetAdminId])

    console.warn('[admin-views] assignments replaced', {
      targetAdminId,
      views: names,
      assignedByAdminId,
    })
    return {
      adminId: targetAdminId,
      views: views
        .map((v) => ({ name: v.name, endpoints: v.endpoints }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  },

  /**
   * Redis-cached permission snapshot used by the auth middleware on every
   * admin request. SUPER_ADMIN never calls this (bypasses in middleware).
   */
  async getAccessSnapshot(adminId: string): Promise<AdminViewAccess> {
    const key = RedisKeys.adminViewAccess(adminId)
    try {
      const cached = await redisClient.get(key)
      if (cached) {
        const parsed = JSON.parse(cached) as CachedAccess
        return { restricted: parsed.restricted, endpoints: new Set(parsed.endpoints) }
      }
    } catch {
      // Fall through to DB on any Redis/parse failure.
    }

    const views = await adminViewRepository.findAssignedViews(adminId)
    const endpoints = new Set<string>()
    for (const view of views) {
      for (const ep of view.endpoints) endpoints.add(normalizeAdminEndpoint(ep))
    }
    const snapshot: CachedAccess = { restricted: views.length > 0, endpoints: [...endpoints] }

    try {
      await redisClient.set(key, JSON.stringify(snapshot), 'EX', ADMIN_VIEW_ACCESS_TTL)
    } catch {
      // Cache write is best-effort.
    }
    return { restricted: snapshot.restricted, endpoints }
  },
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
