import { Prisma } from '@prisma/client'
import { s3Bucket } from '../config/s3'
import { prisma } from '../config/database'
import { RedisKeys } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { agencyAgentApplicationRepository } from '../repositories/agencyAgentApplication.repository'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { agencyRepository } from '../repositories/agency.repository'
import { userRepository } from '../repositories/user.repository'
import { agencyCoinsellerService } from './agencyCoinseller.service'
import { cacheRedisService } from './cacheRedis.service'
import { storageService } from './storage.service'

const PRESIGN_TTL_SEC = 600

function assertApplicationNotTerminal(application: { status: string } | null) {
  if (application?.status === 'APPROVED' || application?.status === 'REJECTED') {
    throw new AppError(400, 'Application is already resolved', 'APPLICATION_RESOLVED')
  }
}

async function bustAgencyKycCaches(userId: string) {
  const agency = await agencyRepository.getAgencyByUserId(userId)
  if (agency) {
    await cacheRedisService.del(
      RedisKeys.agencyMe(userId),
      RedisKeys.agencyByPublicId(agency.defaultPublicId.toString()),
    )
  }
  await cacheRedisService.delByKeyPrefix('agency:ranking:')
}

function govtIdPublicUrl(s3Key: string | null | undefined) {
  const key = s3Key?.trim()
  return key ? storageService.getCdnOrS3PublicUrl(key) : null
}

export const agencyKycService = {
  async getPresignedGovtIdUrl(userId: string, mimeType: string, opts?: { admin?: boolean }) {
    if (opts?.admin) {
      const user = await userRepository.findById(userId)
      if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    } else {
      const application = await agencyAgentApplicationRepository.findByUserId(userId)
      assertApplicationNotTerminal(application)
    }

    const s3Key = `agency/kyc/${userId}/govt-id/${Date.now()}`
    const uploadUrl = await storageService.getPresignedPutUrl(s3Key, mimeType, PRESIGN_TTL_SEC)
    await agencyApplicationKycRepository.upsertKycDetails(userId, {
      govtIdS3Key: s3Key,
    })
    return { uploadUrl, s3Key, expiresInSec: PRESIGN_TTL_SEC }
  },

  async confirmGovtIdUpload(userId: string, s3Key: string, opts?: { admin?: boolean }) {
    if (!opts?.admin) {
      const application = await agencyAgentApplicationRepository.findByUserId(userId)
      assertApplicationNotTerminal(application)
    }

    const kyc = await agencyApplicationKycRepository.getKycByUserIdWrite(userId)
    const pendingKey = kyc?.govtIdS3Key?.trim()
    if (!pendingKey) {
      throw new AppError(
        400,
        'No pending government ID key. Call POST /agency/kyc/govt-id/upload-url first, upload the file, then confirm.',
        'GOVT_ID_UPLOAD_URL_REQUIRED',
      )
    }
    if (s3Key.trim() !== pendingKey) {
      throw new AppError(
        400,
        's3Key does not match the key from your last upload-url response.',
        'GOVT_ID_KEY_MISMATCH',
      )
    }

    const bucket = s3Bucket?.trim()
    if (!bucket) {
      throw new AppError(503, 'File storage is not configured', 'S3_NOT_CONFIGURED')
    }
    await agencyApplicationKycRepository.upsertKycDetails(userId, {
      govtIdS3Key: pendingKey,
      govtIdS3Bucket: bucket,
      govtIdSubmittedAt: new Date(),
    })

    if (opts?.admin) {
      await bustAgencyKycCaches(userId)
    }
  },

  /** Admin replace of government ID — allowed even when the application is APPROVED or REJECTED. */
  async confirmAdminGovtIdUpload(userId: string, s3Key: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    await this.confirmGovtIdUpload(userId, s3Key, { admin: true })
    const updated = await agencyApplicationKycRepository.getKycByUserIdWrite(userId)
    return {
      ok: true as const,
      userId,
      govtIdUrl: govtIdPublicUrl(updated?.govtIdS3Key),
      govtIdSubmittedAt: updated?.govtIdSubmittedAt?.toISOString() ?? null,
    }
  },

  /**
   * Drop a REJECTED application so the user can `POST /agency/kyc/apply` again.
   * Unlinks KYC first (FK is ON DELETE CASCADE) so contact + govt ID are kept.
   */
  async reopenRejectedApplication(userId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const application = await agencyAgentApplicationRepository.findByUserIdWrite(userId)
    if (!application) {
      throw new AppError(404, 'Application not found', 'APPLICATION_NOT_FOUND')
    }
    if (application.status !== 'REJECTED') {
      throw new AppError(
        400,
        'Only a rejected application can be reopened',
        'APPLICATION_NOT_REJECTED',
      )
    }

    await prisma.$transaction(async (tx) => {
      await agencyApplicationKycRepository.upsertKycDetails(userId, { applicationId: null }, tx)
      await agencyAgentApplicationRepository.deleteById(application.id, tx)
    })

    return {
      ok: true as const,
      userId,
      reopened: true as const,
      previousApplicationId: application.id,
    }
  },

  async submitContactInfo(userId: string, payload: { phone: string; email: string }) {
    const application = await agencyAgentApplicationRepository.findByUserId(userId)
    assertApplicationNotTerminal(application)

    await agencyApplicationKycRepository.upsertKycDetails(userId, {
      contactPhone: payload.phone,
      contactEmail: payload.email,
      contactSubmittedAt: new Date(),
    })
    const agency = await agencyRepository.getAgencyByUserId(userId)
    if (agency) {
      await agencyCoinsellerService.syncWhatsappFromKycPhone(userId, payload.phone)
    }
  },

  /**
   * Create agent application after KYC is complete, or return an existing non-terminal application.
   */
  async applyForAgency(userId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    if (user.isAgent) throw new AppError(400, 'Already an agent', 'ALREADY_AGENT')
    if (user.currentAgencyId) {
      throw new AppError(
        409,
        'Leave your current agency before applying to create your own',
        'ALREADY_IN_AGENCY',
      )
    }
    if (user.agencyBarredAt) {
      throw new AppError(403, 'User is barred from operating an agency', 'AGENCY_BARRED')
    }

    const existing = await agencyAgentApplicationRepository.findByUserId(userId)
    if (existing) {
      if (existing.status === 'APPROVED') {
        throw new AppError(400, 'Application already approved', 'ALREADY_APPROVED')
      }
      if (existing.status === 'REJECTED') {
        throw new AppError(
          400,
          'Application was rejected. Contact support to appeal.',
          'APPLICATION_REJECTED',
        )
      }
      return { created: false as const, application: existing }
    }

    const review = await this.getKycStatusForAdmin(userId)
    const missing: string[] = []
    if (!review.govtIdUploaded) missing.push('govtId')
    if (!review.contactSubmitted) missing.push('contactNumber')
    if (!review.faceVerified) missing.push('faceVerification')
    if (missing.length > 0) {
      throw new AppError(400, 'Complete KYC before applying', 'INCOMPLETE_KYC', { missing })
    }

    const application = await prisma.$transaction(
      async (tx) => {
        const created = await agencyAgentApplicationRepository.create(userId, tx)
        await agencyApplicationKycRepository.linkApplicationToKyc(userId, created.id, tx)
        return created
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )

    return { created: true as const, application }
  },

  async getKycStatusForAdmin(userId: string) {
    const row = await agencyApplicationKycRepository.getKycForAdminReview(userId)
    const faceIndexed = row.user?.faceProfile?.status === 'INDEXED'
    const faceOk = Boolean(row.kyc?.faceVerified) || faceIndexed
    const govtKey = row.kyc?.govtIdS3Key?.trim()
    const faceKey = row.user?.faceProfile?.s3KeyReference?.trim()
    return {
      userId,
      govtIdUploaded: Boolean(row.kyc?.govtIdSubmittedAt),
      contactSubmitted: Boolean(row.kyc?.contactSubmittedAt),
      faceVerified: faceOk,
      govtIdUrl: govtKey ? storageService.getCdnOrS3PublicUrl(govtKey) : null,
      faceImageUrl: faceKey ? storageService.getCdnOrS3PublicUrl(faceKey) : null,
      contactPhone: row.kyc?.contactPhone ?? null,
      contactEmail: row.kyc?.contactEmail ?? null,
      contactSubmittedAt: row.kyc?.contactSubmittedAt?.toISOString() ?? null,
      govtIdSubmittedAt: row.kyc?.govtIdSubmittedAt?.toISOString() ?? null,
      kyc: row.kyc,
    }
  },

  async updateAgentContact(userId: string, data: { phone?: string; email?: string }) {
    const patch: { contactPhone?: string; contactEmail?: string } = {}
    if (data.phone) patch.contactPhone = data.phone
    if (data.email) patch.contactEmail = data.email
    await agencyApplicationKycRepository.updateContactByAgentUserId(userId, patch)
    if (data.phone) {
      await agencyCoinsellerService.syncWhatsappFromKycPhone(userId, data.phone)
    }
  },

  /**
   * Admin correction of KYC-linked phone/email. Requires an existing KYC row
   * (user started or submitted agency KYC). Does not change login auth identifiers.
   */
  async updateAdminKycContact(userId: string, data: { phone?: string; email?: string }) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const existing = await agencyApplicationKycRepository.getKycByUserId(userId)
    if (!existing) {
      throw new AppError(404, 'No KYC application found for this user', 'KYC_NOT_FOUND')
    }

    const email = data.email?.trim().toLowerCase()
    await this.updateAgentContact(userId, {
      ...(data.phone ? { phone: data.phone } : {}),
      ...(email ? { email } : {}),
    })

    await bustAgencyKycCaches(userId)

    const updated = await agencyApplicationKycRepository.getKycByUserIdWrite(userId)
    return {
      ok: true as const,
      userId,
      contactPhone: updated?.contactPhone ?? null,
      contactEmail: updated?.contactEmail ?? null,
      contactSubmittedAt: updated?.contactSubmittedAt?.toISOString() ?? null,
    }
  },

  async validateKycComplete(userId: string) {
    const review = await this.getKycStatusForAdmin(userId)
    const missing: ('GOVT_ID' | 'CONTACT_INFO' | 'FACE_AUTH')[] = []
    if (!review.govtIdUploaded) missing.push('GOVT_ID')
    if (!review.contactSubmitted) missing.push('CONTACT_INFO')
    if (!review.faceVerified) missing.push('FACE_AUTH')
    if (missing.length) {
      throw new AppError(422, 'KYC incomplete', 'KYC_INCOMPLETE', { missing })
    }
  },
}
