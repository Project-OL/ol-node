import type { FastifyRequest, FastifyReply } from 'fastify'
import { systemAdminService } from '../services/systemAdmin.service'
import { AppError } from './errorHandler'
import type { AdminRole } from '@prisma/client'

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: {
      id: string
      role: AdminRole
    }
  }
}

export async function authenticateAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError(401, 'Missing admin token', 'ADMIN_TOKEN_MISSING')
  }

  const token = authHeader.slice(7)
  const payload = await systemAdminService.verifyAccessToken(token)

  req.adminUser = { id: payload.sub, role: payload.role }
}

export function requireAdminRole(...roles: AdminRole[]) {
  return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.adminUser) {
      throw new AppError(401, 'Not authenticated as admin', 'ADMIN_TOKEN_MISSING')
    }
    if (!roles.includes(req.adminUser.role)) {
      throw new AppError(403, 'Insufficient admin role', 'ADMIN_FORBIDDEN')
    }
  }
}
