import type { CoinTxType, CustomGiftRequestStatus } from '@prisma/client'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import {
  customGiftRepository,
  type CustomGiftRequestWithUserAndGift,
} from '../repositories/customGift.repository'
import { coinWalletService } from './coin-wallet.service'
import { walletService } from './wallet.service'
import { formatUserName } from '../utils/user-display'
import { toRequestDto, type CustomGiftRequestDto } from './customGift.service'
import type {
  CompleteCustomGiftRequestBody,
  FailCustomGiftRequestBody,
  UpdateCustomGiftConfigBody,
} from '../models/custom-gift.schemas'
import { buildCustomGiftPackages } from '../utils/custom-gift-pricing'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

export interface AdminCustomGiftRequestDto extends CustomGiftRequestDto {
  user: {
    id: string
    username: string
    publicId: string
    name: string
    avatarUrl: string | null
    country: string | null
  }
  adminNote: string | null
  refundLedgerEntryId: string | null
  resolvedByAdminId: string | null
  updatedAt: string
}

function toAdminDto(row: CustomGiftRequestWithUserAndGift): AdminCustomGiftRequestDto {
  return {
    ...toRequestDto(row),
    user: {
      id: row.user.id,
      username: row.user.username,
      publicId: row.user.publicId.toString(),
      name: formatUserName(row.user),
      avatarUrl: row.user.avatarUrl,
      country: row.user.country,
    },
    adminNote: row.adminNote,
    refundLedgerEntryId: row.refundLedgerEntryId,
    resolvedByAdminId: row.resolvedByAdminId,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const customGiftAdminService = {
  async getConfig() {
    const config = await customGiftRepository.getOrCreateConfig()
    const packages = buildCustomGiftPackages(config)
    return {
      coinCost: packages[0]!.coinCost,
      coinCost1Month: packages[0]!.coinCost,
      coinCost3Months: packages[1]!.coinCost,
      enabled: config.enabled,
      description: config.description,
      packages,
      updatedAt: config.updatedAt.toISOString(),
      updatedByAdminId: config.updatedByAdminId,
    }
  },

  async updateConfig(body: UpdateCustomGiftConfigBody, adminId: string) {
    // Legacy `coinCost` updates the 1-month package (and keeps coinCost column in sync).
    const oneMonth =
      body.coinCost1Month != null
        ? body.coinCost1Month
        : body.coinCost != null
          ? body.coinCost
          : undefined

    await customGiftRepository.updateConfig({
      ...(oneMonth != null ? { coinCost: oneMonth, coinCost1Month: oneMonth } : {}),
      ...(body.coinCost3Months != null ? { coinCost3Months: body.coinCost3Months } : {}),
      ...(body.enabled != null ? { enabled: body.enabled } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      updatedByAdminId: adminId,
    })
    return this.getConfig()
  },

  async listRequests(params: {
    status?: CustomGiftRequestStatus
    userId?: string
    page: number
    limit: number
  }): Promise<{
    requests: AdminCustomGiftRequestDto[]
    total: number
    page: number
    limit: number
    countsByStatus: Record<string, number>
  }> {
    const [{ items, total }, counts] = await Promise.all([
      customGiftRepository.adminList(params),
      customGiftRepository.countByStatus(),
    ])
    const countsByStatus: Record<string, number> = { PENDING: 0, COMPLETED: 0, FAILED: 0 }
    for (const c of counts) countsByStatus[c.status] = c.count
    return {
      requests: items.map(toAdminDto),
      total,
      page: params.page,
      limit: params.limit,
      countsByStatus,
    }
  },

  async getRequest(id: string): Promise<AdminCustomGiftRequestDto> {
    const row = await customGiftRepository.findByIdWithUserAndGift(id)
    if (!row) throw new AppError(404, 'Custom gift request not found', 'CUSTOM_GIFT_REQUEST_NOT_FOUND')
    return toAdminDto(row)
  },

  /**
   * PENDING → COMPLETED. The admin has already created the actual gift via the
   * gift-admin endpoints; `giftId` links it to the request (optional).
   */
  async completeRequest(
    id: string,
    body: CompleteCustomGiftRequestBody,
    adminId: string,
  ): Promise<AdminCustomGiftRequestDto> {
    const row = await customGiftRepository.findByIdWithUserAndGift(id)
    if (!row) throw new AppError(404, 'Custom gift request not found', 'CUSTOM_GIFT_REQUEST_NOT_FOUND')

    if (body.giftId) {
      const gift = await prisma.gift.findUnique({ where: { id: body.giftId } })
      if (!gift) throw new AppError(404, 'Linked gift not found', 'GIFT_NOT_FOUND')
    }

    const updated = await customGiftRepository.resolvePending(id, {
      status: 'COMPLETED',
      giftId: body.giftId,
      adminNote: body.adminNote,
      resolvedByAdminId: adminId,
    })
    if (updated === 0) {
      throw new AppError(409, 'Request is already resolved', 'CUSTOM_GIFT_REQUEST_ALREADY_RESOLVED', {
        status: row.status,
      })
    }
    return this.getRequest(id)
  },

  /**
   * PENDING → FAILED with a reason. When `refund` is true the original coin
   * debit is credited back (personal COIN) in the same transaction; the
   * deterministic refund key makes a retried call idempotent.
   */
  async failRequest(
    id: string,
    body: FailCustomGiftRequestBody,
    adminId: string,
  ): Promise<AdminCustomGiftRequestDto> {
    const row = await customGiftRepository.findByIdWithUserAndGift(id)
    if (!row) throw new AppError(404, 'Custom gift request not found', 'CUSTOM_GIFT_REQUEST_NOT_FOUND')

    const updated = await prisma.$transaction(
      async (tx) => {
        const count = await customGiftRepository.resolvePending(
          id,
          {
            status: 'FAILED',
            failureReason: body.reason,
            adminNote: body.adminNote,
            resolvedByAdminId: adminId,
          },
          tx,
        )
        if (count === 0) return 0

        if (body.refund) {
          const { ledgerEntryId } = await coinWalletService.credit(
            row.userId,
            row.coinCost,
            'CUSTOM_GIFT_REFUND' as CoinTxType,
            tx,
            {
              idempotencyKey: `custom-gift-refund:${id}`,
              description: 'Custom gift request refund',
              metadata: { customGiftRequestId: id },
              applyWealthCredit: false,
            },
          )
          await tx.customGiftRequest.update({
            where: { id },
            data: { refunded: true, refundLedgerEntryId: ledgerEntryId },
          })
        }
        return count
      },
      { timeout: INTERACTIVE_TX_TIMEOUT_MS },
    )

    if (updated === 0) {
      throw new AppError(409, 'Request is already resolved', 'CUSTOM_GIFT_REQUEST_ALREADY_RESOLVED', {
        status: row.status,
      })
    }
    if (body.refund) {
      await walletService.adjustCoinBalanceCache(row.userId, row.coinCost)
    }
    return this.getRequest(id)
  },
}
