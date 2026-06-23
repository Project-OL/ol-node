import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { systemAdminService } from '../../services/systemAdmin.service'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'

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
  role: z.enum(['SUPER_ADMIN', 'MODERATOR', 'FINANCE', 'CONTENT']).optional(),
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

  app.get('/auth/me', { preHandler: [authenticateAdmin] }, async (req, reply) => {
    return reply.send({ admin: req.adminUser })
  })
}
