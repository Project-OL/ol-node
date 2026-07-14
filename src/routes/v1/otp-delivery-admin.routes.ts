import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { OtpDeliveryConfigUpdateSchema } from '../../models/otp-delivery-config.schemas'
import { otpDeliveryConfigService } from '../../services/otp-delivery-config.service'

/**
 * Admin OTP delivery routing config.
 * GET/PUT /v1/admin/otp-delivery/config
 */
export default async function otpDeliveryAdminRoutes(app: FastifyInstance) {
  app.get('/otp-delivery/config', { preHandler: [authenticateAdmin] }, async (_request, reply) => {
    const config = await otpDeliveryConfigService.getConfig()
    return reply.send(config)
  })

  app.put('/otp-delivery/config', { preHandler: [authenticateAdmin] }, async (request, reply) => {
    const adminUserId = request.adminUser?.id
    if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const body = OtpDeliveryConfigUpdateSchema.parse(request.body ?? {})
    const config = await otpDeliveryConfigService.updateConfig(adminUserId, body)
    return reply.send(config)
  })
}
