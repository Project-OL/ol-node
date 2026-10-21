/**
 * Graceful drain before shutdown (deploy-time 503s, 2026-10-21).
 *
 * Google's load balancer keeps a pool of idle connections to each backend. When a stopping process
 * closes one at the moment the LB sends a request on it, the client gets a 503
 * `backend_connection_closed_before_data_sent_to_client` (13 in two days, all during restarts).
 *
 * While draining, the process keeps serving but answers every request with `Connection: close`, so
 * the LB retires each connection cleanly after a response; only then does shutdown close the server.
 * Off unless SHUTDOWN_DRAIN_MS > 0, which needs pm2's kill timeout above drain + close time
 * (`pm2 start … --kill-timeout 15000`), or pm2 would kill the process mid-drain.
 */
let draining = false

export const isDraining = (): boolean => draining

/** Start draining and resolve after `ms` (immediately when ms <= 0). */
export const drainFor = async (ms: number): Promise<void> => {
  if (!(ms > 0)) return
  draining = true
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** Test hook. */
export const resetDrainForTests = (): void => {
  draining = false
}
