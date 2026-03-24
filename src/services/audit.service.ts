import { auditRepository } from '../repositories/audit.repository'

function getIp(request: { ip?: string; headers?: Record<string, string | undefined> }): string | undefined {
  const forwarded = request.headers?.['x-forwarded-for']
  if (forwarded) return forwarded.split(',')[0]?.trim()
  return request.ip
}

function getUserAgent(request: { headers?: Record<string, string | undefined> }): string | undefined {
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
   * @param params.actionType - e.g. 'login', 'logout', 'password_change', 'provider_bind'.
   * @param params.actionStatus - 'success' | 'failed'.
   * @param params.actionDetails - Optional JSON-serializable details.
   */
  log(params: {
    userId?: string | null
    actionType: string
    actionStatus: 'success' | 'failed'
    actionDetails?: Record<string, unknown>
    request?: { ip?: string; headers?: Record<string, string | undefined> }
    ipAddress?: string
    userAgent?: string
    deviceId?: string | null
  }) {
    const ip = params.ipAddress ?? (params.request ? getIp(params.request) : undefined)
    const ua = params.userAgent ?? (params.request ? getUserAgent(params.request) : undefined)
    auditRepository
      .log({
        userId: params.userId,
        actionType: params.actionType,
        actionStatus: params.actionStatus,
        actionDetails: params.actionDetails,
        ipAddress: ip,
        userAgent: ua,
        deviceId: params.deviceId,
      })
      .catch((err) => console.error('[audit] log failed', err))
  },
}
