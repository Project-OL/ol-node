import { env } from '../config/env'

/**
 * SEC-12: Fastify `trustProxy` setting. With a hop count, `request.ip` is the address that many hops in
 * from the socket (proxy-addr), so a client-supplied `X-Forwarded-For: 1.2.3.4` can't become the
 * rate-limit key. Without one, keep the old `true` (leftmost entry) so an unconfigured env behaves as
 * before.
 */
export function trustProxySetting(): number | boolean {
  return env.TRUST_PROXY_HOPS ?? true
}

/**
 * The caller's IP for rate limits, audit rows and session records. Never read `X-Forwarded-For`
 * directly: its leftmost value is whatever the client sent.
 */
export function clientIp(request?: { ip?: string } | null): string | undefined {
  const ip = request?.ip?.trim()
  return ip ? ip : undefined
}
