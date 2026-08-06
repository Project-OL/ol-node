import { Prisma } from '@prisma/client'
import { s3Bucket } from '../config/s3'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { agencyAgentApplicationRepository } from '../repositories/agencyAgentApplication.repository'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { agencyRepository } from '../repositories/agency.repository'
import { userRepository } from '../repositories/user.repository'
import { agencyCoinsellerService } from './agencyCoinseller.service'
import { storageService } from './storage.service'

const PRESIGN_TTL_SEC = 600

function assertApplicationNotTerminal(application: { status: string } | null) {
  if (application?.status === 'APPROVED' || application?.status === 'REJECTED') {
    throw new AppError(400, 'Application is already resolved', 'APPLICATION_RESOLVED')
  }
}

export const agencyKycService = {
  async getPresignedGovtIdUrl(userId: string, mimeType: string) {
    const application = await agencyAgentApplicationRepository.findByUserId(userId)
    assertApplicationNotTerminal(application)

    const s3Key = `agency/kyc/${userId}/govt-id/${Date.now()}`
    const uploadUrl = await storageService.getPresignedPutUrl(s3Key, mimeType, PRESIGN_TTL_SEC)
    await agencyApplicationKycRepository.upsertKycDetails(userId, {
      govtIdS3Key: s3Key,
    })
    return { uploadUrl, s3Key, expiresInSec: PRESIGN_TTL_SEC }
  },

  async confirmGovtIdUpload(userId: string, s3Key: string) {
    const application = await agencyAgentApplicationRepository.findByUserId(userId)
    assertApplicationNotTerminal(application)

    const kyc = await agencyApplicationKycRepository.getKycByUserId(userId)
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
