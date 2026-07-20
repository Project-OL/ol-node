import type { FastifyRequest, FastifyReply } from 'fastify'
import { systemAdminService } from '../services/systemAdmin.service'
import {
  adminViewService,
  normalizeAdminEndpoint,
  type AdminViewAccess,
} from '../services/adminView.service'
import { redisClient, RedisKeys, ADMIN_ONLINE_TTL } from '../config/redis'
import { env } from '../config/env'
import { AppError } from './errorHandler'
import type { AdminRole } from '@prisma/client'

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: {
      id: string
      role: AdminRole
    }
    /** View-permission snapshot; set by authenticateAdmin for non-SUPER_ADMIN admins. */
    adminViewAccess?: AdminViewAccess
  }
}

const API_PREFIX = `/api/${env.API_VERSION}`

/**
 * Endpoints every authenticated admin keeps regardless of view assignments —
 * session upkeep and the notification/presence poll must never lock out.
 */
const BASE_ALLOWED_ENDPOINTS = new Set(
  [
    'POST /admin/auth/logout',
    'GET /admin/auth/me',
    'GET /admin/views/me',
    'GET /admin/support/notifications',
    'GET /admin/support/notifications/badge',
    'POST /admin/support/notifications/read',
  ].map(normalizeAdminEndpoint),
)

/** Normalized "METHOD /admin/..." key for the registered route handling this request. */
function requestEndpointKey(req: FastifyRequest): string | null {
  const routePath =
    req.routeOptions?.url ?? (req as FastifyRequest & { routerPath?: string }).routerPath
  if (!routePath) return null
  const relative = routePath.startsWith(API_PREFIX) ? routePath.slice(API_PREFIX.length) : routePath
  const method = req.method === 'HEAD' ? 'GET' : req.method
  return normalizeAdminEndpoint(`${method} ${relative}`)
}

export async function authenticateAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'Missing admin token', 'ADMIN_TOKEN_MISSING')
  }

  const token = authHeader.slice(7)
  const payload = await systemAdminService.verifyAccessToken(token)

  req.adminUser = { id: payload.sub, role: payload.role }

  // View gating: SUPER_ADMIN bypasses; an admin with >=1 assigned view may only
  // call endpoints inside those views (plus the session/notification baseline).
  // Admins with no assignments keep legacy role-only gating.
  if (payload.role !== 'SUPER_ADMIN') {
    const access = await adminViewService.getAccessSnapshot(payload.sub)
    req.adminViewAccess = access
    if (access.restricted) {
      const endpointKey = requestEndpointKey(req)
      if (
        endpointKey &&
        !access.endpoints.has(endpointKey) &&
        !BASE_ALLOWED_ENDPOINTS.has(endpointKey)
      ) {
        throw new AppError(403, 'Endpoint not in your assigned views', 'ADMIN_VIEW_FORBIDDEN')
      }
    }
  }

  // Presence heartbeat — any authenticated admin request marks the admin online.
  void redisClient
    .set(RedisKeys.adminOnline(payload.sub), '1', 'EX', ADMIN_ONLINE_TTL)
    .catch(() => null)
}

export function requireAdminRole(...roles: AdminRole[]) {
  return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.adminUser) {
      throw new AppError(401, 'Not authenticated as admin', 'ADMIN_TOKEN_MISSING')
    }
    if (roles.includes(req.adminUser.role)) return

    // An assigned view explicitly listing this endpoint grants access even when
    // the role alone wouldn't (views are the per-CSA permission mechanism).
    if (req.adminViewAccess?.restricted) {
      const endpointKey = requestEndpointKey(req)
      if (endpointKey && req.adminViewAccess.endpoints.has(endpointKey)) return
    }

    throw new AppError(403, 'Insufficient admin role', 'ADMIN_FORBIDDEN')
  }
}
