import { rootLogger } from './rootLogger'

type MinimalLogger = { error: (obj: Record<string, unknown>, msg: string) => void }

/**
 * Registers uncaughtException/unhandledRejection handlers that log with full
 * context and trigger a non-zero-exit shutdown — a clean, logged exit rather
 * than Node's default bare-stderr crash or, worse, an unhandled rejection
 * silently leaving the process alive in a bad state.
 */
export function registerCrashHandlers(
  processName: string,
  shutdown: (exitCode: number) => void | Promise<void>,
  log: MinimalLogger = rootLogger,
): void {
  process.on('uncaughtException', (err) => {
    log.error({ err }, `[${processName}] uncaught exception — shutting down`)
    void shutdown(1)
  })
  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, `[${processName}] unhandled rejection — shutting down`)
    void shutdown(1)
  })
}
