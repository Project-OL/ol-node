import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { systemAdminService } from '../../services/systemAdmin.service'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { passwordSchema } from '../../models/schemas'
import { mintAdminWsTicket } from '../../services/ws-ticket.service'

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

const RefreshBody = z.object({
  refreshToken: z.string(),
})

const CreateAdminBody = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  displayName: z.string().min(2),
  role: z.enum(['SUPER_ADMIN', 'MODERATOR', 'FINANCE', 'CONTENT', 'CUSTOMER_SUPPORT']).optional(),
  username: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
  phone: z.string().min(4).max(20).optional(),
  phoneCountryCode: z.string().min(1).max(8).optional(),
  gender: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
})

/** Optional: omit to auto-generate. When set, must satisfy strength policy and be ≥12 chars. */
const ResetAdminPasswordBody = z.object({
  newPassword: passwordSchema
    .refine((v) => v.length >= 12, 'Password must be at least 12 characters')
    .optional(),
})

export async function registerAdminAuthRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body)
    const result = await systemAdminService.login(body.email, body.password, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    })
    return reply.code(200).send(result)
  })

  app.post('/auth/refresh', async (req, reply) => {
    const body = RefreshBody.parse(req.body)
    const result = await systemAdminService.refresh(body.refreshToken)
    return reply.code(200).send(result)
  })

  app.post('/auth/logout', { preHandler: [authenticateAdmin] }, async (req, reply) => {
    if (req.adminUser) {
      await systemAdminService.logout(req.adminUser.id)
    }
    return reply.code(204).send()
  })

  app.post('/auth/create-admin', { preHandler: [authenticateAdmin] }, async (req, reply) => {
    if (req.adminUser?.role !== 'SUPER_ADMIN') {
      throw new AppError(403, 'SUPER_ADMIN only', 'ADMIN_FORBIDDEN')
    }
    const body = CreateAdminBody.parse(req.body)
    const admin = await systemAdminService.createAdmin(body)
    return reply.code(201).send({
      id: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      role: admin.role,
      createdAt: admin.createdAt,
    })
  })

  app.post<{ Params: { adminId: string } }>(
    '/auth/admins/:adminId/password/reset',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Auth'],
        description:
          'SUPER_ADMIN only. Reset any system admin password (CSA / MODERATOR / FINANCE / CONTENT / SUPER_ADMIN). Omitting `newPassword` returns a one-time `temporaryPassword`. Revokes all sessions for the target.',
      },
    },
    async (req, reply) => {
      if (req.adminUser?.role !== 'SUPER_ADMIN') {
        throw new AppError(403, 'SUPER_ADMIN only', 'ADMIN_FORBIDDEN')
      }
      const parsed = ResetAdminPasswordBody.safeParse(req.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const result = await systemAdminService.resetPassword({
        targetAdminId: req.params.adminId,
        actorAdminId: req.adminUser.id,
        newPassword: parsed.data.newPassword,
      })
      return reply.code(200).send(result)
    },
  )

  app.get('/auth/me', { preHandler: [authenticateAdmin] }, async (req, reply) => {
    return reply.send({ admin: req.adminUser })
  })

  /** Mint a short-lived single-use WS upgrade ticket for the authenticated admin. */
  app.post('/auth/ws-ticket', { preHandler: [authenticateAdmin] }, async (req, reply) => {
    if (!req.adminUser) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const result = await mintAdminWsTicket(req.adminUser.id)
    return reply.send(result)
  })
}
