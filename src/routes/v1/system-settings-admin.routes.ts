import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  HostRevenueSharesUpdateSchema,
  ReplaceCoinPackagesSchema,
  ReplaceRatesSchema,
  WalletLevelConfigsReplaceSchema,
} from '../../models/system-rates-admin.schemas'
import { hostRevenueShareConfigService } from '../../services/hostRevenueShareConfig.service'
import { systemRatesAdminService } from '../../services/systemRatesAdmin.service'

/**
 * Platform-wide coin / point rate configs (System Settings).
 *
 * GET  /v1/admin/system-settings/rates
 * GET|PUT /v1/admin/system-settings/host-revenue-shares
 * GET|PUT /v1/admin/system-settings/personal-exchange-rates
 * GET|PUT /v1/admin/system-settings/coin-packages
 * GET|PUT /v1/admin/system-settings/wallet-level-configs
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
}
