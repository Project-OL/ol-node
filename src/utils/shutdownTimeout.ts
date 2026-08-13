/**
 * Runs `fn`, forcing continuation after `ms` if it hangs — a stuck disconnect
 * (DB, Redis, BullMQ worker close) must not block process exit indefinitely.
 */
export async function withShutdownTimeout(fn: () => Promise<void>, ms = 10_000): Promise<void> {
  await Promise.race([fn(), new Promise<void>((resolve) => setTimeout(resolve, ms))])
}
