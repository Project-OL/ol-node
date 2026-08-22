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
import { AdminAuthConfigUpdateSchema } from '../../models/adminAuthConfig.schemas'
import { AgencyHostConfigUpdateSchema } from '../../models/agencyHostConfig.schemas'
import { LivestreamRewardConfigUpdateSchema } from '../../models/livestreamRewardConfig.schemas'
import { AccountDeletionConfigUpdateSchema } from '../../models/accountDeletionConfig.schemas'
import { ReplaceRestrictedIdentityWordsSchema } from '../../models/restrictedIdentityWords.schemas'
import { hostRevenueShareConfigService } from '../../services/hostRevenueShareConfig.service'
import { messagingConfigService } from '../../services/messagingConfig.service'
import { supportConfigService } from '../../services/supportConfig.service'
import { faceLivenessConfigService } from '../../services/faceLivenessConfig.service'
import { adminAuthConfigService } from '../../services/adminAuthConfig.service'
import { agencyHostConfigService } from '../../services/agencyHostConfig.service'
import { livestreamRewardConfigService } from '../../services/livestreamRewardConfig.service'
import { accountDeletionConfigService } from '../../services/accountDeletionConfig.service'
import { restrictedIdentityWordsService } from '../../services/restrictedIdentityWords.service'
import { systemRatesAdminService } from '../../services/systemRatesAdmin.service'
import { videoCallPriceCapService } from '../../services/videoCallPriceCap.service'
import { richTierService } from '../../services/rich-tier.service'
import { auditService } from '../../services/audit.service'

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
 * GET|PUT /v1/admin/system-settings/admin-auth
 * GET|PUT /v1/admin/system-settings/agency-host
 * GET|PUT /v1/admin/system-settings/livestream-reward
 * GET|PUT /v1/admin/system-settings/account-deletion
 * GET|PUT /v1/admin/system-settings/restricted-words
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
      const result = await hostRevenueShareConfigService.updateConfig(adminUserId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'host-revenue-shares' },
      })
      return reply.send(result)
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
      const result = await systemRatesAdminService.replacePersonalExchangeRates(body.tiers)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'personal-exchange-rates' },
      })
      return reply.send(result)
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
      const result = await systemRatesAdminService.replaceCoinPackages(body.packages)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'coin-packages' },
      })
      return reply.send(result)
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
      const result = await systemRatesAdminService.replaceWalletLevelConfigs(body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'wallet-level-configs' },
      })
      return reply.send(result)
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
      const result = await videoCallPriceCapService.replaceCaps(body.tiers)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'video-call-price-caps' },
      })
      return reply.send(result)
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
      const tiers = await richTierService.replaceTierConfig(body.tiers)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'rich-tier' },
      })
      return reply.send({ tiers })
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
      const result = await messagingConfigService.updateConfig(adminUserId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'messaging' },
      })
      return reply.send(result)
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
      const result = await supportConfigService.updateConfig(adminUserId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'support' },
      })
      return reply.send(result)
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
      const result = await faceLivenessConfigService.updateConfig(adminUserId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'face-liveness' },
      })
      return reply.send(result)
    },
  )

  app.get(
    '/system-settings/admin-auth',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await adminAuthConfigService.getConfig())
    },
  )

  app.put(
    '/system-settings/admin-auth',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = AdminAuthConfigUpdateSchema.parse(request.body ?? {})
      const result = await adminAuthConfigService.updateConfig(adminUserId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'admin-auth' },
      })
      return reply.send(result)
    },
  )

  app.get(
    '/system-settings/agency-host',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await agencyHostConfigService.getConfig())
    },
  )

  app.put(
    '/system-settings/agency-host',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = AgencyHostConfigUpdateSchema.parse(request.body ?? {})
      const result = await agencyHostConfigService.updateConfig(adminUserId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'agency-host' },
      })
      return reply.send(result)
    },
  )

  app.get(
    '/system-settings/livestream-reward',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await livestreamRewardConfigService.getConfig())
    },
  )

  app.put(
    '/system-settings/livestream-reward',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = LivestreamRewardConfigUpdateSchema.parse(request.body ?? {})
      const result = await livestreamRewardConfigService.updateConfig(adminUserId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'livestream-reward' },
      })
      return reply.send(result)
    },
  )

  app.get(
    '/system-settings/account-deletion',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await accountDeletionConfigService.getConfig())
    },
  )

  app.put(
    '/system-settings/account-deletion',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const body = AccountDeletionConfigUpdateSchema.parse(request.body ?? {})
      const result = await accountDeletionConfigService.updateConfig(adminUserId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'account-deletion' },
      })
      return reply.send(result)
    },
  )

  app.get(
    '/system-settings/restricted-words',
    { preHandler: [authenticateAdmin] },
    async (_request, reply) => {
      return reply.send(await restrictedIdentityWordsService.listWords())
    },
  )

  app.put(
    '/system-settings/restricted-words',
    { preHandler: [authenticateAdmin] },
    async (request, reply) => {
      const body = ReplaceRestrictedIdentityWordsSchema.parse(request.body ?? {})
      const result = await restrictedIdentityWordsService.replaceWords(body.words)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_SYSTEM_SETTINGS_UPDATED',
        actionDetails: { settingKey: 'restricted-words' },
      })
      return reply.send(result)
    },
  )
}
