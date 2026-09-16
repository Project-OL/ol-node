import ExcelJS from 'exceljs'
import { AppError } from '../middlewares/errorHandler'
import {
  rewardClaimsRepository,
  type RewardClaimType,
} from '../repositories/rewardClaims.repository'
import type {
  ListRewardClaimsQuery,
  ExportRewardClaimsQuery,
} from '../models/admin-rewards.schemas'

const EXPORT_ROW_CAP = 10_000

const TYPE_LABEL: Record<RewardClaimType, string> = {
  NORMAL_HOST: 'Normal Host',
  ROYAL_HOST: 'Royal Host',
  LIVESTREAM_STREAK: 'Livestream Streak',
}

function dateRange(query: { from?: string; to?: string }) {
  return {
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  }
}

export const rewardClaimsService = {
  async listClaims(query: ListRewardClaimsQuery) {
    const { from, to } = dateRange(query)
    const skip = (query.page - 1) * query.limit

    const { items: userTotals, total } = await rewardClaimsRepository.listUsersByTotalClaimed({
      country: query.country,
      agencyUserId: query.agencyUserId,
      from,
      to,
      type: query.type,
      skip,
      take: query.limit,
    })

    const userIds = userTotals.map((u) => u.userId)
    const claims = await rewardClaimsRepository.listClaimsForUsers({
      userIds,
      from,
      to,
      type: query.type,
    })

    const reversedIds = await rewardClaimsRepository.findReversedLedgerEntryIds(
      claims.map((c) => c.ledgerEntryId),
    )

    const claimsByUser = new Map<string, typeof claims>()
    for (const claim of claims) {
      const list = claimsByUser.get(claim.userId)
      if (list) list.push(claim)
      else claimsByUser.set(claim.userId, [claim])
    }

    const users = userTotals.map((u) => ({
      userId: u.userId,
      username: u.username,
      country: u.country,
      publicId: u.publicId.toString(),
      totalPoints: u.totalPoints.toString(),
      claimCount: Number(u.claimCount),
      claims: (claimsByUser.get(u.userId) ?? []).map((c) => ({
        type: c.type,
        typeLabel: TYPE_LABEL[c.type],
        date: c.claimDate.toISOString().slice(0, 10),
        pointsAmount: c.pointsAmount.toString(),
        ledgerEntryId: c.ledgerEntryId,
        claimedAt: c.claimedAt.toISOString(),
        reverted: reversedIds.has(c.ledgerEntryId),
      })),
    }))

    return {
      users,
      page: query.page,
      limit: query.limit,
      total,
      hasMore: query.page * query.limit < total,
    }
  },

  async exportClaimsXlsx(
    query: ExportRewardClaimsQuery,
  ): Promise<{ buffer: Buffer; count: number }> {
    const { from, to } = dateRange(query)
    const rows = await rewardClaimsRepository.listAllClaims({
      country: query.country,
      agencyUserId: query.agencyUserId,
      from,
      to,
      type: query.type,
    })
    if (rows.length > EXPORT_ROW_CAP) {
      throw new AppError(413, 'Export too large — narrow the filter', 'EXPORT_TOO_LARGE')
    }

    const reversedIds = await rewardClaimsRepository.findReversedLedgerEntryIds(
      rows.map((r) => r.ledgerEntryId),
    )

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Reward Claims')
    sheet.columns = [
      { header: 'Username', key: 'username', width: 24 },
      { header: 'Public ID', key: 'publicId', width: 14 },
      { header: 'Country', key: 'country', width: 18 },
      { header: 'Reward Type', key: 'type', width: 20 },
      { header: 'Claim Date', key: 'date', width: 14 },
      { header: 'Points', key: 'points', width: 14 },
      { header: 'Claimed At', key: 'claimedAt', width: 22 },
      { header: 'Reverted', key: 'reverted', width: 12 },
    ]
    for (const r of rows) {
      sheet.addRow({
        username: r.username,
        publicId: r.publicId.toString(),
        country: r.country ?? '',
        type: TYPE_LABEL[r.type],
        date: r.claimDate.toISOString().slice(0, 10),
        points: r.pointsAmount.toString(),
        claimedAt: r.claimedAt.toISOString(),
        reverted: reversedIds.has(r.ledgerEntryId) ? 'Yes' : 'No',
      })
    }
    sheet.getRow(1).font = { bold: true }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
    return { buffer, count: rows.length }
  },
}
