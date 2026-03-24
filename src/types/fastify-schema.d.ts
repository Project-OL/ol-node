import 'fastify'

declare module 'fastify' {
  interface FastifySchema {
    tags?: string[]
    description?: string
  }
}

