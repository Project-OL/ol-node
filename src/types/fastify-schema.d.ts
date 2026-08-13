import 'fastify'

declare module 'fastify' {
  interface FastifySchema {
    tags?: string[]
    description?: string
  }

  interface FastifyContextConfig {
    /** Per-route override for the global request-timeout hook (see utils/requestTimeout.ts). */
    timeoutMs?: number
  }
}
