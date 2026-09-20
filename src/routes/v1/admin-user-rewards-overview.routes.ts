import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { adminUserRewardsOverviewService } from '../../services/adminUserRewardsOverview.service'

const preAuth = [authenticateAdmin]

/** Per-user reward eligibility/claims + live-session timing snapshot. Prefix: /admin/users */
export default async function adminUserRewardsOverviewRoutes(app: FastifyInstance) {
  app.get<{ Params: { userId: string } }>(
    '/users/:userId/rewards-overview',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Rewards'],
        description:
          'Normal Host / Royal Host / Livestream Streak reward eligibility and full claim/deduction history for one user, plus their live-session effective timing for today and this (Sunday-starting UTC) week.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminUserRewardsOverviewService.getRewardsOverview(request.params.userId),
      )
    },
  )
}
