import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  HostRevenueSharesUpdateSchema,
  ReplaceCoinPackagesSchema,
  ReplaceRatesSchema,
  ReplaceVideoCallPriceCapsSchema,
  WalletLevelConfigsReplaceSchema,
  ReplaceRichTierConfigSchema,
} from '../../models/system-rates-admin.schemas'
import { SupportConfigUpdateSchema } from '../../models/supportConfig.schemas'
import { MessagingConfigUpdateSchema } from '../../models/messagingConfig.schemas'
import { FaceLivenessConfigUpdateSchema } from '../../models/faceLivenessConfig.schemas'
import { hostRevenueShareConfigService } from '../../services/hostRevenueShareConfig.service'
import { messagingConfigService } from '../../services/messagingConfig.service'
import { supportConfigService } from '../../services/supportConfig.service'
import { faceLivenessConfigService } from '../../services/faceLivenessConfig.service'
import { systemRatesAdminService } from '../../services/systemRatesAdmin.service'
import { videoCallPriceCapService } from '../../services/videoCallPriceCap.service'
import { richTierService } from '../../services/rich-tier.service'

/**
 * Platform-wide coin / point rate configs (System Settings).
 *
 * GET  /v1/admin/system-settings/rates
 * GET|PUT /v1/admin/system-settings/host-revenue-shares
 * GET|PUT /v1/admin/system-settings/personal-exchange-rates
 * GET|PUT /v1/admin/system-settings/coin-packages
 * GET|PUT /v1/admin/system-settings/wallet-level-configs
 * GET|PUT /v1/admin/system-settings/video-call-price-caps
 * GET|PUT /v1/admin/system-settings/rich-tier
 * GET|PUT /v1/admin/system-settings/messaging
 * GET|PUT /v1/admin/system-settings/support
 * GET|PUT /v1/admin/system-settings/face-liveness
 */
export default async function systemSettingsAdminRoutes(app: FastifyInstance) {
  app.get(
    '/system-settings/rates',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await systemRatesAdminService.getAggregateRates())
    },
  )

  app.get(
    '/system-settings/host-revenue-shares',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await hostRevenueShareConfigService.getConfig())
    },
  )

  app.put(
    '/system-settings/host-revenue-shares',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = HostRevenueSharesUpdateSchema.parse(request.body ?? {})
      return reply.send(await hostRevenueShareConfigService.updateConfig(adminUserId, body))
    },
  )

  app.get(
    '/system-settings/personal-exchange-rates',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await systemRatesAdminService.getPersonalExchangeRates())
    },
  )

  app.put(
    '/system-settings/personal-exchange-rates',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const body = ReplaceRatesSchema.parse(request.body ?? {})
      return reply.send(await systemRatesAdminService.replacePersonalExchangeRates(body.tiers))
    },
  )

  app.get(
    '/system-settings/coin-packages',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await systemRatesAdminService.getCoinPackages())
    },
  )

  app.put(
    '/system-settings/coin-packages',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const body = ReplaceCoinPackagesSchema.parse(request.body ?? {})
      return reply.send(await systemRatesAdminService.replaceCoinPackages(body.packages))
    },
  )

  app.get(
    '/system-settings/wallet-level-configs',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await systemRatesAdminService.getWalletLevelConfigs())
    },
  )

  app.put(
    '/system-settings/wallet-level-configs',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const body = WalletLevelConfigsReplaceSchema.parse(request.body ?? {})
      return reply.send(await systemRatesAdminService.replaceWalletLevelConfigs(body))
    },
  )

  app.get(
    '/system-settings/video-call-price-caps',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await videoCallPriceCapService.getCaps())
    },
  )

  app.put(
    '/system-settings/video-call-price-caps',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const body = ReplaceVideoCallPriceCapsSchema.parse(request.body ?? {})
      return reply.send(await videoCallPriceCapService.replaceCaps(body.tiers))
    },
  )

  app.get(
    '/system-settings/rich-tier',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send({ tiers: await richTierService.getTierConfig() })
    },
  )

  app.put(
    '/system-settings/rich-tier',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const body = ReplaceRichTierConfigSchema.parse(request.body ?? {})
      return reply.send({ tiers: await richTierService.replaceTierConfig(body.tiers) })
    },
  )

  app.get(
    '/system-settings/messaging',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await messagingConfigService.getConfig())
    },
  )

  app.put(
    '/system-settings/messaging',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = MessagingConfigUpdateSchema.parse(request.body ?? {})
      return reply.send(await messagingConfigService.updateConfig(adminUserId, body))
    },
  )

  app.get(
    '/system-settings/support',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await supportConfigService.getConfig())
    },
  )

  app.put(
    '/system-settings/support',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = SupportConfigUpdateSchema.parse(request.body ?? {})
      return reply.send(await supportConfigService.updateConfig(adminUserId, body))
    },
  )

  app.get(
    '/system-settings/face-liveness',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await faceLivenessConfigService.getConfig())
    },
  )

  app.put(
    '/system-settings/face-liveness',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = FaceLivenessConfigUpdateSchema.parse(request.body ?? {})
      return reply.send(await faceLivenessConfigService.updateConfig(adminUserId, body))
    },
  )
}
