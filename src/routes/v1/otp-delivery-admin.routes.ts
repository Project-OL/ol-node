import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminListOtpDeliveryAuditsQuerySchema,
  adminOtpCountryRateDeleteQuerySchema,
  adminOtpCountryRateUpsertSchema,
  adminOtpDeliveryAuditSummaryQuerySchema,
  adminOtpMonthlyCostQuerySchema,
} from '../../models/otp-delivery-audit.schemas'
import { OtpDeliveryConfigUpdateSchema } from '../../models/otp-delivery-config.schemas'
import { AppError } from '../../middlewares/errorHandler'
import { otpDeliveryAuditService } from '../../services/otp-delivery-audit.service'
import { otpDeliveryConfigService } from '../../services/otp-delivery-config.service'
import { parseRequest } from '../../utils/zod-request'

/**
 * Admin OTP delivery routing config + delivery audit log.
 * GET/PUT /v1/admin/otp-delivery/config
 * GET /v1/admin/otp-delivery/audits
 * GET /v1/admin/otp-delivery/audits/summary
 * GET /v1/admin/otp-delivery/costs/monthly
 * GET /v1/admin/otp-delivery/costs/by-country
 * GET /v1/admin/otp-delivery/cost-rates
 * PUT /v1/admin/otp-delivery/cost-rates
 * DELETE /v1/admin/otp-delivery/cost-rates
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

  app.get(
    '/otp-delivery/cost-rates',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'OTP delivery'],
        description:
          'Configured per-channel OTP delivery costs (minor currency units) used when recording audits.',
      },
    },
    async (_request, reply) => {
      return reply.send(await otpDeliveryAuditService.getCostRates())
    },
  )

  app.put(
    '/otp-delivery/cost-rates',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'OTP delivery'],
        description:
          'Set or update a per-country WhatsApp/SMS cost override (minor units of the global OTP_COST_CURRENCY). Overrides the flat rates.whatsapp/rates.sms default for that country. Email is not country-priced.',
        body: {
          type: 'object',
          required: ['means', 'country', 'rateMinor'],
          properties: {
            means: { type: 'string', enum: ['whatsapp', 'sms'] },
            country: { type: 'string', minLength: 2, maxLength: 2 },
            rateMinor: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = parseRequest(adminOtpCountryRateUpsertSchema, request.body ?? {})
      const rate = await otpDeliveryAuditService.setCountryRate({ ...body, updatedByUserId: adminUserId })
      return reply.send(rate)
    },
  )

  app.delete(
    '/otp-delivery/cost-rates',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'OTP delivery'],
        description:
          'Remove a per-country WhatsApp/SMS cost override, reverting that country to the flat env default.',
        querystring: {
          type: 'object',
          required: ['means', 'country'],
          properties: {
            means: { type: 'string', enum: ['whatsapp', 'sms'] },
            country: { type: 'string', minLength: 2, maxLength: 2 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = parseRequest(adminOtpCountryRateDeleteQuerySchema, request.query ?? {})
      await otpDeliveryAuditService.deleteCountryRate(query.means, query.country)
      return reply.send({ success: true })
    },
  )

  app.get(
    '/otp-delivery/costs/monthly',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'OTP delivery'],
        description:
          'OTP delivery cost for a UTC calendar month (default: current), broken down by email / WhatsApp / SMS.',
        querystring: {
          type: 'object',
          properties: {
            year: { type: 'integer', minimum: 2020, maximum: 2100 },
            month: { type: 'integer', minimum: 1, maximum: 12 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = parseRequest(adminOtpMonthlyCostQuerySchema, request.query ?? {})
      const result = await otpDeliveryAuditService.monthlyCosts(query)
      return reply.send(result)
    },
  )

  app.get(
    '/otp-delivery/costs/by-country',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'OTP delivery'],
        description:
          'Per-country OTP cost table for a UTC calendar month: count and charge for email / WhatsApp / SMS.',
        querystring: {
          type: 'object',
          properties: {
            year: { type: 'integer', minimum: 2020, maximum: 2100 },
            month: { type: 'integer', minimum: 1, maximum: 12 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = parseRequest(adminOtpMonthlyCostQuerySchema, request.query ?? {})
      const result = await otpDeliveryAuditService.costsByCountry(query)
      return reply.send(result)
    },
  )

  app.get(
    '/otp-delivery/audits',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'OTP delivery'],
        description:
          'Paginated OTP delivery audit log. Timestamps and year/month filters are UTC. Optional year+month uses the same UTC calendar month window as costs endpoints.',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            purpose: {
              type: 'string',
              enum: [
                'signup',
                'login',
                'reset_password',
                'set_security_password',
                'bind_email',
                'bind_phone',
                'modify_email',
                'modify_phone',
              ],
            },
            means: { type: 'string', enum: ['email', 'whatsapp', 'sms', 'none'] },
            status: { type: 'string', enum: ['success', 'failed', 'skipped'] },
            userId: { type: 'string', format: 'uuid' },
            country: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            year: { type: 'integer', minimum: 2020, maximum: 2100 },
            month: { type: 'integer', minimum: 1, maximum: 12 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = parseRequest(adminListOtpDeliveryAuditsQuerySchema, request.query ?? {})
      const result = await otpDeliveryAuditService.list(query)
      return reply.send(result)
    },
  )

  app.get(
    '/otp-delivery/audits/summary',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'OTP delivery'],
        description:
          'Aggregated OTP delivery counts/charges. Timestamps and year/month filters are UTC (same month window as costs).',
        querystring: {
          type: 'object',
          properties: {
            purpose: {
              type: 'string',
              enum: [
                'signup',
                'login',
                'reset_password',
                'set_security_password',
                'bind_email',
                'bind_phone',
                'modify_email',
                'modify_phone',
              ],
            },
            means: { type: 'string', enum: ['email', 'whatsapp', 'sms', 'none'] },
            status: { type: 'string', enum: ['success', 'failed', 'skipped'] },
            userId: { type: 'string', format: 'uuid' },
            country: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            year: { type: 'integer', minimum: 2020, maximum: 2100 },
            month: { type: 'integer', minimum: 1, maximum: 12 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = parseRequest(adminOtpDeliveryAuditSummaryQuerySchema, request.query ?? {})
      const result = await otpDeliveryAuditService.summarize(query)
      return reply.send(result)
    },
  )
}
