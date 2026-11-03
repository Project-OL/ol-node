import type { FastifyRequest } from 'fastify'
import { auditRepository } from '../repositories/audit.repository'
import { clientIp } from '../utils/client-ip'
import { adminAuditMetaFromRequest, type AdminAuditRequestMeta } from '../utils/admin-audit'

function getIp(request: {
  ip?: string
  headers?: Record<string, string | undefined>
}): string | undefined {
  // SEC-12: request.ip honours TRUST_PROXY_HOPS; the leftmost X-Forwarded-For is client-controlled.
  return clientIp(request)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * BE-07: audit_logs.user_id / admin_user_id are UUID columns. A non-UUID actor such as 'system'
 * made the whole insert fail (P2023, ~5.8k lost rows before 2026-10-19), so keep it in the
 * details instead and store null.
 */
function uuidOrNull(
  value: string | null | undefined,
  field: string,
  details: Record<string, unknown>,
): string | null | undefined {
  if (value == null || UUID_RE.test(value)) return value
  details[`${field}NonUuid`] = value
  return null
}

function getUserAgent(request: {
  headers?: Record<string, string | undefined>
}): string | undefined {
  return request.headers?.['user-agent']
}

/**
 * Audit logging for auth and security events.
 * Persists action type, status, optional details, IP, user-agent, and device.
 */
export const auditService = {
  /**
   * Log an audit event (fire-and-forget). Does not await DB; avoids adding latency to the request.
   * Provide either `request` (for IP/user-agent) or explicit `ipAddress`/`userAgent`.
   * @param params.userId - Subject user (optional for anonymous actions).
   * @param params.adminUserId - System admin actor (`system_admins.id`).
   * @param params.actionType - e.g. 'login', 'logout', 'password_change', 'provider_bind'.
   * @param params.actionStatus - 'success' | 'failed'.
   * @param params.actionDetails - Optional JSON-serializable details.
   */
  log(params: {
    userId?: string | null
    adminUserId?: string | null
    actionType: string
    actionStatus: 'success' | 'failed'
    actionDetails?: Record<string, unknown>
    request?: AdminAuditRequestMeta
    ipAddress?: string
    userAgent?: string
    deviceId?: string | null
  }) {
    const ip = params.ipAddress ?? (params.request ? getIp(params.request) : undefined)
    const ua = params.userAgent ?? (params.request ? getUserAgent(params.request) : undefined)
    const extra: Record<string, unknown> = {}
    const userId = uuidOrNull(params.userId, 'userId', extra)
    const adminUserId = uuidOrNull(params.adminUserId, 'adminUserId', extra)
    auditRepository
      .log({
        userId,
        adminUserId,
        actionType: params.actionType,
        actionStatus: params.actionStatus,
        actionDetails: Object.keys(extra).length
          ? { ...(params.actionDetails ?? {}), ...extra }
          : params.actionDetails,
        ipAddress: ip,
        userAgent: ua,
        deviceId: params.deviceId,
      })
      .catch((err) => console.error('[audit] log failed', err))
  },

  /**
   * Log a system-admin action. Sets `adminUserId`, optional target user on `userId`,
   * merges adminUserId into actionDetails for legacy readers, and captures IP when provided.
   */
  logAdmin(params: {
    adminUserId: string
    targetUserId?: string | null
    actionType: string
    actionStatus: 'success' | 'failed'
    actionDetails?: Record<string, unknown>
    destination?: string
    request?: AdminAuditRequestMeta
    ipAddress?: string
    userAgent?: string
    deviceId?: string | null
  }) {
    const details: Record<string, unknown> = {
      ...(params.actionDetails ?? {}),
      adminUserId: params.adminUserId,
    }
    if (params.targetUserId) details.targetUserId = params.targetUserId
    if (params.destination) details.destination = params.destination

    this.log({
      adminUserId: params.adminUserId,
      userId: params.targetUserId ?? null,
      actionType: params.actionType,
      actionStatus: params.actionStatus,
      actionDetails: details,
      request: params.request,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      deviceId: params.deviceId,
    })
  },

  /**
   * Route-layer helper: attribute a successful admin mutation to `request.adminUser`.
   * No-ops when the request has no admin actor (should not happen on authenticated admin routes).
   */
  logAdminFromRequest(
    request: FastifyRequest,
    params: {
      actionType: string
      targetUserId?: string | null
      actionDetails?: Record<string, unknown>
      destination?: string
      actionStatus?: 'success' | 'failed'
    },
  ) {
    const adminUserId = request.adminUser?.id
    if (!adminUserId) return
    this.logAdmin({
      adminUserId,
      targetUserId: params.targetUserId,
      actionType: params.actionType,
      actionStatus: params.actionStatus ?? 'success',
      actionDetails: params.actionDetails,
      destination: params.destination,
      request: adminAuditMetaFromRequest(request),
    })
  },
}
