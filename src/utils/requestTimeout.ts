import type { FastifyRequest, FastifyReply } from 'fastify'

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
