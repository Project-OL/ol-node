import { env } from '../config/env'

/**
 * SEC-12: Fastify `trustProxy` setting. With a hop count, `request.ip` is the address that many hops in
 * from the socket (proxy-addr), so a client-supplied `X-Forwarded-For: 1.2.3.4` can't become the
 * rate-limit key. Without one, keep the old `true` (leftmost entry) so an unconfigured env behaves as
 * before.
 */
export function trustProxySetting(): boolean | ((addr: string, hop: number) => boolean) {
  return trustProxyFromHops(env.TRUST_PROXY_HOPS)
}

/**
 * BE-21: Fastify 5 treats a *numeric* `trustProxy` as "trust nothing" (5.12: hop counts can't verify
 * the immediate peer), which would make every `request.ip` the load balancer's address. Hand it the
 * exact function proxy-addr built for a hop count under Fastify 4 instead: trust the `hops` nearest
 * addresses (hop 0 = the socket peer). Safe here because the app VMs have no public address, so the
 * socket peer is always the LB (prod) or nginx (staging).
 */
export function trustProxyFromHops(hops: number | undefined): boolean | ((addr: string, hop: number) => boolean) {
  if (hops === undefined) return true
  return (_addr: string, hop: number) => hop < hops
}

/**
 * The caller's IP for rate limits, audit rows and session records. Never read `X-Forwarded-For`
 * directly: its leftmost value is whatever the client sent.
 */
export function clientIp(request?: { ip?: string } | null): string | undefined {
  const ip = request?.ip?.trim()
  return ip ? ip : undefined
}
