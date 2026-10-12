import { describe, it, expect, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

vi.mock('../../src/config/env', () => ({ env: { NODE_ENV: 'production' } }))

import { AppError, errorHandler } from '../../src/middlewares/errorHandler'

function fakeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    log: { info: vi.fn(), error: vi.fn() },
    header: vi.fn(),
    status(code: number) {
      reply.statusCode = code
      return reply
    },
    send(b: unknown) {
      reply.body = b
      return reply
    },
  }
  return reply
}

describe('errorHandler client-input mapping', () => {
  it('maps an escaped ZodError to 400 INVALID_REQUEST instead of 500', () => {
    const parsed = z.object({ email: z.string().email() }).safeParse({ email: '' })
    const reply = fakeReply()
    errorHandler((parsed as { error: z.ZodError }).error as never, {} as never, reply as never)
    expect(reply.statusCode).toBe(400)
    expect(reply.body).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'email: Invalid email',
      details: { issues: [{ path: 'email', message: 'Invalid email' }] },
    })
  })

  it('maps Prisma P2000 (value too long) to 400 VALUE_TOO_LONG', () => {
    const err = new Prisma.PrismaClientKnownRequestError('too long', {
      code: 'P2000',
      clientVersion: 'test',
      meta: { column_name: 'upi_number' },
    })
    const reply = fakeReply()
    errorHandler(err as never, {} as never, reply as never)
    expect(reply.statusCode).toBe(400)
    expect(reply.body).toMatchObject({ code: 'VALUE_TOO_LONG', message: 'Value too long for upi_number' })
  })

  it('logs the code of a 4xx AppError (request logs only carry the status)', () => {
    const reply = fakeReply()
    errorHandler(new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID') as never, {} as never, reply as never)
    expect(reply.statusCode).toBe(400)
    expect(reply.log.info).toHaveBeenCalledWith(
      { statusCode: 400, code: 'INVALID_PUBLIC_ID' },
      'Invalid public ID',
    )
    expect(reply.log.error).not.toHaveBeenCalled()
  })

  it('logs a 5xx AppError at error level', () => {
    const reply = fakeReply()
    errorHandler(new AppError(503, 'Busy', 'BUSY') as never, {} as never, reply as never)
    expect(reply.log.error).toHaveBeenCalledWith({ statusCode: 503, code: 'BUSY' }, 'Busy')
  })

  it('logs a mapped client-input error once, not twice', () => {
    const reply = fakeReply()
    const parsed = z.object({ a: z.string() }).safeParse({})
    errorHandler((parsed as { error: z.ZodError }).error as never, {} as never, reply as never)
    expect(reply.log.info).toHaveBeenCalledTimes(1)
  })

  it('still hides unexpected errors as 500 in production', () => {
    const reply = fakeReply()
    errorHandler(new Error('db down') as never, {} as never, reply as never)
    expect(reply.statusCode).toBe(500)
    expect(reply.body).toMatchObject({ error: 'Internal Server Error' })
  })
})
