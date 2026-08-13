import type { FastifyRequest, FastifyReply } from 'fastify'

/**
 * Default active-request timeout applied globally (see app.ts's requestTimeout
 * preHandler hook) — well above the measured p99 for cached/typical reads, well
 * below the 30s socket-level `connectionTimeout` so this fires first with a clean
 * error rather than the connection dying on the coarser idle timeout.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/**
 * Override budget for routes that are a genuinely different kind of workload —
 * bulk export / heavy multi-query aggregation — not just "a normal read that
 * happens to be a bit slower". Set via a route's `config: { timeoutMs: ... }`.
 */
export const SLOW_REPORT_TIMEOUT_MS = 60_000

/**
 * Returns a preHandler that sets a per-route request timeout (in ms).
 * Use for heavy read endpoints to avoid long-running handlers holding connections.
 * When the timeout fires, the request socket is destroyed (client will see connection reset).
 */
export function requestTimeout(ms: number) {
  return async function timeoutPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const raw = request.raw
    const timeout = setTimeout(() => {
      if (!reply.sent) {
        raw.destroy()
      }
    }, ms)
    raw.on('close', () => clearTimeout(timeout))
  }
}

/**
 * Global onRequest hook: applies {@link DEFAULT_REQUEST_TIMEOUT_MS} to every
 * request, or a route's own `config: { timeoutMs }` override when set (e.g.
 * {@link SLOW_REPORT_TIMEOUT_MS} for bulk export / heavy aggregation routes).
 * Skips protocol-upgrade requests (WebSocket) and any path `isExemptPath`
 * flags (e.g. /health) entirely — a fixed destroy-after-ms would kill
 * long-lived WS connections, which already have their own idle-timeout
 * mechanism (WS_IDLE_TIMEOUT_MS in ws.gateway.ts).
 */
export function globalRequestTimeoutHook(isExemptPath: (url: string) => boolean) {
  return async function globalTimeoutOnRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (request.raw.headers.upgrade || isExemptPath(request.url)) return
    const ms = request.routeOptions?.config?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const raw = request.raw
    const timeout = setTimeout(() => {
      if (!reply.sent) {
        raw.destroy()
      }
    }, ms)
    raw.on('close', () => clearTimeout(timeout))
  }
}
