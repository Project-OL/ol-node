import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  LuckyTierConfigVersionCreateSchema,
  LuckyTierIdParamSchema,
  LuckyTierModeUpdateSchema,
  LuckyTierSeedBodySchema,
} from '../../models/lucky-tier-admin.schemas'
import { auditService } from '../../services/audit.service'
import { luckyTierAdminService } from '../../services/luckyTierAdmin.service'
import type { LuckyTierId } from '../../services/luckyWater/bandWeights'

/**
 * Water-level lucky tier admin (System Settings extension).
 *
 * GET  /admin/system-settings/lucky-tiers
 * GET  /admin/system-settings/lucky-tiers/:tierId
 * GET  /admin/system-settings/lucky-tiers/:tierId/dashboard
 * POST /admin/system-settings/lucky-tiers/:tierId/versions
 * PUT  /admin/system-settings/lucky-tiers/:tierId/mode
 * POST /admin/system-settings/lucky-tiers/:tierId/seed
 */
export default async function luckyTierAdminRoutes(app: FastifyInstance) {
  const preAuth = [authenticateAdmin]

  app.get('/system-settings/lucky-tiers', { preHandler: preAuth }, async (_request, reply) => {
    return reply.send(await luckyTierAdminService.listTiers())
  })

  app.get(
    '/system-settings/lucky-tiers/:tierId',
    { preHandler: preAuth },
    async (request, reply) => {
      const { tierId } = LuckyTierIdParamSchema.parse(request.params)
      return reply.send(await luckyTierAdminService.getTier(tierId as LuckyTierId))
    },
  )

  app.get(
    '/system-settings/lucky-tiers/:tierId/dashboard',
    { preHandler: preAuth },
    async (request, reply) => {
      const { tierId } = LuckyTierIdParamSchema.parse(request.params)
      return reply.send(await luckyTierAdminService.getDashboard(tierId as LuckyTierId))
    },
  )

  app.post(
    '/system-settings/lucky-tiers/:tierId/versions',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const { tierId } = LuckyTierIdParamSchema.parse(request.params)
      const body = LuckyTierConfigVersionCreateSchema.parse(request.body ?? {})
      const before = await luckyTierAdminService.getTier(tierId as LuckyTierId)
      const created = await luckyTierAdminService.createConfigVersion(adminUserId, tierId as LuckyTierId, {
        rBp: body.rBp,
        jBp: body.jBp,
        l0: body.l0 != null ? BigInt(body.l0) : undefined,
        floor: body.floor != null ? BigInt(body.floor) : undefined,
        lambdaCriticalMaxBp: body.lambdaCriticalMaxBp,
        lambdaLowMaxBp: body.lambdaLowMaxBp,
        lambdaNormalMaxBp: body.lambdaNormalMaxBp,
        bandWeights: body.bandWeights,
        weightTableId: body.weightTableId,
        mMax: body.mMax,
        vMaxBp: body.vMaxBp,
        safetyMarginBp: body.safetyMarginBp,
        minGapBp: body.minGapBp,
        dailyWinCapCoins: body.dailyWinCapCoins != null ? BigInt(body.dailyWinCapCoins) : undefined,
        coolDownAfterBigWinSeconds: body.coolDownAfterBigWinSeconds,
      })
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_LUCKY_TIER_CONFIG_VERSION',
        actionDetails: {
          tierId,
          before: { version: before.version, mode: before.mode, rBp: before.rBp },
          after: { version: created.version, mode: created.mode, rBp: created.rBp },
        },
      })
      return reply.status(201).send(created)
    },
  )

  app.put(
    '/system-settings/lucky-tiers/:tierId/mode',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const { tierId } = LuckyTierIdParamSchema.parse(request.params)
      const body = LuckyTierModeUpdateSchema.parse(request.body ?? {})
      const before = await luckyTierAdminService.getTier(tierId as LuckyTierId)
      const updated = await luckyTierAdminService.setMode(
        adminUserId,
        tierId as LuckyTierId,
        body.mode,
        body.enforceOverrideReason,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_LUCKY_TIER_MODE',
        actionDetails: {
          tierId,
          before: { version: before.version, mode: before.mode },
          after: { version: updated.version, mode: updated.mode },
          enforceOverrideReason: body.enforceOverrideReason ?? null,
        },
      })
      return reply.send(updated)
    },
  )

  app.post(
    '/system-settings/lucky-tiers/:tierId/seed',
    { preHandler: preAuth },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const { tierId } = LuckyTierIdParamSchema.parse(request.params)
      const body = LuckyTierSeedBodySchema.parse(request.body ?? {})
      const before = await luckyTierAdminService.getTier(tierId as LuckyTierId)
      const amount = body.amount != null ? BigInt(body.amount) : 0n
      const result = await luckyTierAdminService.recordSeedDecision(
        adminUserId,
        tierId as LuckyTierId,
        body.choice,
        amount,
        body.reason,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_LUCKY_TIER_SEED',
        actionDetails: {
          tierId,
          choice: body.choice,
          amount: amount.toString(),
          reason: body.reason ?? null,
          beforePoolBalance: before.poolBalance,
          afterPoolBalance: result.poolBalance,
          seedLogId: result.seedLogId,
        },
      })
      return reply.status(201).send(result)
    },
  )
}
