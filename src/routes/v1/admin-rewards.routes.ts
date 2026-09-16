import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { parseRequest } from '../../utils/zod-request'
import { SLOW_REPORT_TIMEOUT_MS } from '../../utils/requestTimeout'
import { rewardClaimsService } from '../../services/rewardClaims.service'
import {
  ListRewardClaimsQuerySchema,
  ExportRewardClaimsQuerySchema,
} from '../../models/admin-rewards.schemas'

const preAuth = [authenticateAdmin]

/** Reward-claim dashboard: Normal Host / Royal Host / Livestream Streak claims, per-user totals. Prefix: /admin/rewards */
export default async function adminRewardsRoutes(app: FastifyInstance) {
  app.get(
    '/rewards/claims',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Rewards'],
        description:
          'Reward claims (Normal/Royal Host, Livestream Streak) aggregated per user, sorted by total claimed desc. Filter by country, type, and claim date range.',
      },
    },
    async (request, reply) => {
      const query = parseRequest(ListRewardClaimsQuerySchema, request.query)
      return reply.send(await rewardClaimsService.listClaims(query))
    },
  )

  app.get(
    '/rewards/claims/export',
    {
      preHandler: preAuth,
      config: { timeoutMs: SLOW_REPORT_TIMEOUT_MS },
      schema: {
        tags: ['Admin', 'Rewards'],
        description:
          'Excel export of reward claims for the given filter (country/type/date range).',
      },
    },
    async (request, reply) => {
      const query = parseRequest(ExportRewardClaimsQuerySchema, request.query)
      const { buffer } = await rewardClaimsService.exportClaimsXlsx(query)
      const date = new Date().toISOString().slice(0, 10)
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="reward-claims-${date}.xlsx"`)
        .send(buffer)
    },
  )
}
