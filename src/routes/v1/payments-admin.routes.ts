import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  adminPaymentRefundBodySchema,
  paymentSuspectListQuerySchema,
  paymentSuspectPatchBodySchema,
  paymentTxnListQuerySchema,
} from '../../models/payments-admin.schemas'
import { auditService } from '../../services/audit.service'
import { paymentRefundService } from '../../services/payment-refund.service'
import { paymentAttentionService } from '../../services/payment-attention.service'
import { paymentSuspectsService } from '../../services/payment-suspects.service'
import { paymentTransactionsService } from '../../services/payment-transactions.service'
import { parseRequest } from '../../utils/zod-request'

/**
 * Payment transaction list (Epay / Google Play / Apple), refunds and the payment suspect list.
 * GET   /v1/admin/payments/transactions
 * GET   /v1/admin/payments/suspects
 * PATCH /v1/admin/payments/suspects/:id
 * POST  /v1/admin/payments/refunds
 * Company-wide finance: refused to country-restricted admins (adminCountryScope).
 */
export default async function paymentsAdminRoutes(app: FastifyInstance) {
  app.get(
    '/payments/transactions',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Payments'],
        description:
          'Purchases, refunds and payouts with Epay / Google Play / Apple, newest first. Cursor pagination (nextCursor).',
      },
    },
    async (request, reply) => {
      const q = parseRequest(paymentTxnListQuerySchema, request.query ?? {})
      return reply.send(await paymentTransactionsService.list(q))
    },
  )

  app.get(
    '/payments/attention',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Payments'],
        description:
          'Payments that need a person: Epay pay-ins held for REVIEW, payouts with an unknown outcome (> 10 min) and payouts refused for low merchant balance (withdrawal still unpaid).',
      },
    },
    async (_request, reply) => reply.send(await paymentAttentionService.list()),
  )

  app.get(
    '/payments/suspects',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Payments'],
        description: 'Payment suspect list (phones, emails, devices, users tied to refunds).',
      },
    },
    async (request, reply) => {
      const q = parseRequest(paymentSuspectListQuerySchema, request.query ?? {})
      return reply.send(await paymentSuspectsService.list(q))
    },
  )

  app.patch(
    '/payments/suspects/:id',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Payments'],
        description:
          'Clear or re-activate a suspect entry. Does NOT lift the account suspension (do that on the user).',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const { id } = request.params as { id: string }
      const body = parseRequest(paymentSuspectPatchBodySchema, request.body ?? {})
      const result = await paymentSuspectsService.setStatus({ id, ...body, adminUserId })
      auditService.logAdmin({
        adminUserId,
        actionType: 'ADMIN_PAYMENT_SUSPECT_STATUS',
        actionStatus: 'success',
        actionDetails: { id, status: body.status },
      })
      return reply.send(result)
    },
  )

  app.post(
    '/payments/refunds',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Payments'],
        description:
          'Apply the refund policy to a recorded purchase: take the coins back (balance may go negative), suspend + freeze the account, add the buyer to the suspect list. Idempotent per refund id.',
      },
    },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = parseRequest(adminPaymentRefundBodySchema, request.body ?? {})
      const result = await paymentRefundService.applyRefund({
        channel: body.channel,
        purchaseExternalId: body.purchaseExternalId,
        refundExternalId: body.refundExternalId ?? null,
        refundAmount: body.refundAmount ? new Prisma.Decimal(body.refundAmount) : null,
        reason: `Admin: ${body.reason}`,
        metadata: { recordedByAdminId: adminUserId },
      })
      if (result.outcome === 'PURCHASE_NOT_FOUND') {
        throw new AppError(404, 'No recorded purchase with that id', 'PURCHASE_NOT_FOUND')
      }
      auditService.logAdmin({
        adminUserId,
        targetUserId: result.userId,
        actionType: 'ADMIN_PAYMENT_REFUND_APPLIED',
        actionStatus: 'success',
        actionDetails: { ...body, outcome: result.outcome, refundTxnId: result.refundTxnId },
      })
      return reply.code(result.outcome === 'APPLIED' ? 201 : 200).send(result)
    },
  )
}
