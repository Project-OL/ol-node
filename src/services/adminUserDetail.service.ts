import { WalletCurrencyType } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import { authIdentifierRepository } from '../repositories/auth-identifier.repository'
import {
  adminUserDetailRepository,
  type AdminUserDetailRow,
} from '../repositories/adminUserDetail.repository'
import { agencyHostRepository } from '../repositories/agencyHost.repository'
import { agencyRepository } from '../repositories/agency.repository'
import { bannedDeviceRepository } from '../repositories/bannedDevice.repository'
import { deviceRepository } from '../repositories/device.repository'
import { userRepository } from '../repositories/user.repository'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { walletRepository } from '../repositories/wallet.repository'
import type { AdminUserPatchBody } from '../models/admin-user-detail.schemas'
import { normalizeAdminPatchTags } from '../models/admin-user-detail.schemas'
import { cacheService } from './cache.service'
import { meService } from './me.service'
import { pointWalletService } from './point-wallet.service'
import { providerService } from './provider.service'
import { sessionService } from './session.service'
import { vipMembershipService } from './vip-membership.service'
import { walletService } from './wallet.service'
import { richTierService } from './rich-tier.service'
import { walletLevelService } from './user-level.service'
import { storeAdminService } from './store-admin.service'
import { phoneSchema } from '../models/schemas'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'
import { normalizeGenderStored } from '../utils/profileDisplay'

function pickAuth(
  row: AdminUserDetailRow,
  provider: 'email' | 'phone',
): { value: string | null; verified: boolean } {
  const primary = row.authIdentifiers.find((i) => i.provider === provider && i.isPrimary)
  const any = row.authIdentifiers.find((i) => i.provider === provider)
  const hit = primary ?? any
  return {
    value: hit?.identifier ?? null,
    verified: hit?.isVerified ?? false,
  }
}

async function buildAgencyBlock(userId: string, isAgent: boolean) {
  if (isAgent) {
    const agency = await agencyRepository.getAgencyByUserId(userId)
    if (agency) {
      return {
        isMember: true,
        role: 'agent' as const,
        agencyUserId: agency.userId,
        agencyPublicId: agency.defaultPublicId.toString(),
        agencyName: agency.displayName,
      }
    }
  }

  const hostRow = await agencyHostRepository.getHostWithAgency(userId)
  if (hostRow) {
    return {
      isMember: true,
      role: 'host' as const,
      agencyUserId: hostRow.agency.userId,
      agencyPublicId: hostRow.agency.defaultPublicId.toString(),
      agencyName: hostRow.agency.displayName,
    }
  }

  return {
    isMember: false,
    role: null,
    agencyUserId: null,
    agencyPublicId: null,
    agencyName: null,
  }
}

async function buildDevicesBlock(userId: string, lastIpAddress: string | null) {
  const [devices, bans] = await Promise.all([
    deviceRepository.findByUserId(userId),
    bannedDeviceRepository.listByRelatedUserId(userId),
  ])
  const bannedSet = new Set(bans.map((b: { deviceId: string }) => b.deviceId))

  const mapped = devices.map((d: (typeof devices)[number]) => ({
    registryId: d.id,
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    platform: d.platform,
    lastActiveAt: d.lastActiveAt.toISOString(),
    loginAt: d.loginAt.toISOString(),
    ipAddress: d.ipAddress,
    isBanned: bannedSet.has(d.deviceId),
  }))

  const ipSet = new Set<string>()
  if (lastIpAddress?.trim()) ipSet.add(lastIpAddress.trim())
  for (const d of mapped) {
    if (d.ipAddress?.trim()) ipSet.add(d.ipAddress.trim())
  }

  return {
    devices: mapped,
    ipAddresses: [...ipSet],
  }
}

async function buildVipBlock(userId: string, row: AdminUserDetailRow) {
  const now = new Date()
  const rareIdActive =
    row.currentVipPublicId != null &&
    (row.vipPublicIdExpiresAt == null || row.vipPublicIdExpiresAt > now)

  const [membership, richTier] = await Promise.all([
    vipMembershipService.buildMeVipMembershipBlock(userId),
    richTierService.getRichTierCardFields(userId),
  ])

  return {
    displayPublicId: resolveDisplayPublicId(row),
    currentVipPublicId: row.currentVipPublicId?.toString() ?? null,
    vipPublicIdExpiresAt: row.vipPublicIdExpiresAt?.toISOString() ?? null,
    rareIdActive,
    vipSubscriptionActive: row.vipSubscriptionActive,
    vipSubscriptionExpiresAt: row.vipSubscriptionExpiresAt?.toISOString() ?? null,
    membership: {
      isActive: membership.isActive,
      tier: membership.tier ?? null,
      expiresAt: membership.expiresAt ?? null,
      daysRemaining: membership.daysRemaining,
    },
    richTier: {
      tier: richTier.tier,
      displayName: richTier.displayName,
    },
  }
}

function resolveDeviceAndIp(
  row: AdminUserDetailRow,
  session: Awaited<ReturnType<typeof adminUserDetailRepository.getLatestSession>>,
  device: Awaited<ReturnType<typeof adminUserDetailRepository.getLatestDevice>>,
) {
  const deviceId = session?.deviceId ?? device?.deviceId ?? null
  const deviceName = session?.deviceName ?? device?.deviceName ?? null
  const ipAddress = row.lastIpAddress ?? session?.ipAddress ?? device?.ipAddress ?? null
  const lastLoggedInAt =
    session?.lastActiveAt?.toISOString() ??
    device?.lastActiveAt?.toISOString() ??
    row.lastActiveAt?.toISOString() ??
    null

  return { deviceId, deviceName, ipAddress, lastLoggedInAt }
}

export const adminUserDetailService = {
  async getUserDetail(userId: string) {
    const row = await adminUserDetailRepository.findUser(userId)
    if (!row) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const [session, device, agency, vip, email, phone, levels, devicesBlock, store] =
      await Promise.all([
      adminUserDetailRepository.getLatestSession(userId),
      adminUserDetailRepository.getLatestDevice(userId),
      buildAgencyBlock(userId, row.isAgent),
      buildVipBlock(userId, row),
      Promise.resolve(pickAuth(row, 'email')),
      Promise.resolve(pickAuth(row, 'phone')),
      walletLevelService.getDisplayLevelsForUsers([userId]),
      buildDevicesBlock(userId, row.lastIpAddress),
      storeAdminService.getUserStoreSummary(userId),
    ])

    const deviceInfo = resolveDeviceAndIp(row, session, device)
    const level = levels.get(userId) ?? { wealthLevel: 0, livestreamLevel: 0 }
    const ipAddresses = [...devicesBlock.ipAddresses]
    if (row.lastIpAddress?.trim() && !ipAddresses.includes(row.lastIpAddress.trim())) {
      ipAddresses.unshift(row.lastIpAddress.trim())
    }

    return {
      userId: row.id,
      username: row.username,
      name: buildUserDisplayName(row),
      publicId: row.publicId.toString(),
      avatarUrl: row.avatarUrl,
      bio: row.bio,
      vip,
      email: email.value,
      emailVerified: email.verified,
      phone: phone.value,
      phoneVerified: phone.verified,
      gender: normalizeGenderStored(row.gender),
      country: row.country,
      joinedAt: row.createdAt.toISOString(),
      lastLoggedInAt: deviceInfo.lastLoggedInAt,
      lastActiveAt: row.lastActiveAt?.toISOString() ?? deviceInfo.lastLoggedInAt,
      wealthLevel: level.wealthLevel,
      livestreamLevel: level.livestreamLevel,
      tags: row.adminTags,
      agency,
      ipAddress: deviceInfo.ipAddress,
      ipAddresses,
      deviceName: deviceInfo.deviceName,
      deviceId: deviceInfo.deviceId,
      devices: devicesBlock.devices,
      status: row.status,
      suspendedUntil: row.suspendedUntil?.toISOString() ?? null,
      walletFreeze: {
        personalCoinsFrozen: row.personalCoinsFrozen,
        tradingCoinsFrozen: row.tradingCoinsFrozen,
        pointsFrozen: row.pointsFrozen,
      },
      posting: {
        banned: row.postingBanned,
        suspendedUntil: row.postingSuspendedUntil?.toISOString() ?? null,
      },
      store,
    }
  },

  async getUserWallet(userId: string) {
    const row = await adminUserDetailRepository.findUser(userId)
    if (!row) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const [personalCoins, pointsBreakdown, tradingWallet, totalRecharged, totalWithdrawn] =
      await Promise.all([
        walletService.getCoinBalance(userId),
        pointWalletService.getBalanceBreakdown(userId),
        walletRepository.getOrCreate(userId, WalletCurrencyType.TRADING_COIN),
        adminUserDetailRepository.sumPersonalCoinRecharge(userId),
        adminUserDetailRepository.sumProcessedWithdrawals(userId),
      ])

    const tradingCoins = await coinLedgerRepository.computeBalance(tradingWallet.id)

    return {
      userId,
      personalCoinBalance: personalCoins.toString(),
      personalPointBalance: pointsBreakdown.total.toString(),
      availablePoints: pointsBreakdown.available.toString(),
      unconfirmedPoints: pointsBreakdown.unconfirmed.toString(),
      tradingCoinBalance: tradingCoins.toString(),
      totalCoinsRecharged: totalRecharged.toString(),
      totalWithdrawalProcessedPoints: totalWithdrawn.toString(),
      freeze: {
        personalCoinsFrozen: row.personalCoinsFrozen,
        tradingCoinsFrozen: row.tradingCoinsFrozen,
        pointsFrozen: row.pointsFrozen,
      },
    }
  },

  async updateUser(userId: string, body: AdminUserPatchBody) {
    const row = await adminUserDetailRepository.findUser(userId)
    if (!row) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    if (body.username != null) {
      await userRepository.update(userId, { username: body.username })
    }

    if (body.gender !== undefined) {
      await userRepository.updateProfile(userId, { gender: body.gender })
    }

    if (body.country !== undefined) {
      await userRepository.updateProfile(userId, { country: body.country })
    }

    if (body.tags != null) {
      const adminTags = normalizeAdminPatchTags(body.tags)
      await userRepository.setAdminTags(userId, adminTags)
      await meService.invalidateUserCaches(userId)
    }

    if (body.email != null) {
      await adminUserDetailService.upsertAuthIdentifier(userId, 'email', body.email.toLowerCase())
    }

    if (body.phone != null) {
      const parsed = phoneSchema.safeParse(body.phone)
      if (!parsed.success) {
        throw new AppError(400, 'Invalid phone format (E.164)', 'INVALID_PHONE')
      }
      await adminUserDetailService.upsertAuthIdentifier(userId, 'phone', parsed.data)
    }

    let statusChanged = false
    if (body.status != null) {
      statusChanged = await adminUserDetailService.applyStatusChange(userId, body.status)
    }

    if (statusChanged) {
      await sessionService.revokeAllSessions(userId)
      await userRepository.incrementTokenVersion(userId)
    }

    return adminUserDetailService.getUserDetail(userId)
  },

  async upsertAuthIdentifier(
    userId: string,
    provider: 'email' | 'phone',
    identifier: string,
  ): Promise<void> {
    providerService.validateProvider(provider, identifier)

    const taken = await authIdentifierRepository.findByProviderAndIdentifier(provider, identifier)
    if (taken && taken.userId !== userId) {
      throw new AppError(
        409,
        provider === 'email' ? 'Email already in use' : 'Phone already in use',
        provider === 'email' ? 'EMAIL_TAKEN' : 'PHONE_TAKEN',
      )
    }

    const existing = await authIdentifierRepository.findByUserId(userId)
    const row = existing.find((a) => a.provider === provider)

    if (row) {
      const ok = await authIdentifierRepository.updateIdentifier(
        userId,
        provider,
        identifier,
        row.version,
      )
      if (!ok) {
        throw new AppError(409, 'Auth identifier conflict, retry', 'IDENTIFIER_VERSION_CONFLICT')
      }
    } else {
      await authIdentifierRepository.create({
        userId,
        provider,
        identifier,
        isVerified: true,
        isPrimary: true,
      })
    }

    await cacheService.invalidateUserAuthIdentifiers(userId)
    await meService.invalidateUserCaches(userId)
  },

  async applyStatusChange(userId: string, status: AdminUserPatchBody['status']): Promise<boolean> {
    if (!status) return false

    if (status.action === 'active') {
      await userRepository.update(userId, { status: 'active', suspendedUntil: null })
      return true
    }

    if (status.action === 'ban') {
      await userRepository.update(userId, { status: 'banned', suspendedUntil: null })
      return true
    }

    if (status.suspendDays != null && status.suspendedUntil != null) {
      throw new AppError(400, 'Provide suspendDays or suspendedUntil, not both', 'INVALID_REQUEST')
    }
    if (status.suspendDays == null && status.suspendedUntil == null) {
      throw new AppError(
        400,
        'Either suspendDays or suspendedUntil is required for suspend',
        'INVALID_REQUEST',
      )
    }

    let until: Date
    if (status.suspendedUntil) {
      until = new Date(status.suspendedUntil)
      if (until.getTime() <= Date.now()) {
        throw new AppError(400, 'suspendedUntil must be in the future', 'INVALID_REQUEST')
      }
    } else {
      until = new Date(Date.now() + (status.suspendDays ?? 1) * 86_400_000)
    }
    await userRepository.update(userId, { status: 'suspended', suspendedUntil: until })
    return true
  },
}
