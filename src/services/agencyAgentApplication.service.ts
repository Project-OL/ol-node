import type { AgencyAgentApplicationStatus } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import { agencyAgentApplicationRepository } from '../repositories/agencyAgentApplication.repository'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { storageService } from './storage.service'
import { formatUserName } from '../utils/user-display'

function faceImageUrlFromProfile(
  faceProfile: { s3KeyReference?: string | null } | null | undefined,
): string | null {
  const key = faceProfile?.s3KeyReference?.trim()
  return key ? storageService.getCdnOrS3PublicUrl(key) : null
}

function buildKycReviewStatus(
  kyc: {
    govtIdSubmittedAt: Date | null
    contactSubmittedAt: Date | null
    faceVerified: boolean
    govtIdS3Key?: string | null
    contactPhone: string | null
    contactEmail: string | null
  } | null,
  faceProfile: { status?: string | null; s3KeyReference?: string | null } | null | undefined,
) {
  const faceIndexed = faceProfile?.status === 'INDEXED'
  const faceOk = Boolean(kyc?.faceVerified) || faceIndexed
  const govtKey = kyc?.govtIdS3Key?.trim()
  return {
    govtIdUploaded: Boolean(kyc?.govtIdSubmittedAt),
    govtIdUrl: govtKey ? storageService.getCdnOrS3PublicUrl(govtKey) : null,
    govtIdSubmittedAt: kyc?.govtIdSubmittedAt?.toISOString() ?? null,
    contactSubmitted: Boolean(kyc?.contactSubmittedAt),
    contactPhone: kyc?.contactPhone ?? null,
    contactEmail: kyc?.contactEmail ?? null,
    contactSubmittedAt: kyc?.contactSubmittedAt?.toISOString() ?? null,
    faceVerified: faceOk,
    faceImageUrl: faceImageUrlFromProfile(faceProfile),
    isComplete: Boolean(kyc?.govtIdSubmittedAt) && Boolean(kyc?.contactSubmittedAt) && faceOk,
  }
}

export const agencyAgentApplicationService = {
  async listForAdminReview(params: {
    statuses?: AgencyAgentApplicationStatus[]
    skip: number
    take: number
  }) {
    const [rows, total] = await Promise.all([
      agencyAgentApplicationRepository.listByStatus(params.statuses, params.skip, params.take),
      agencyAgentApplicationRepository.count(params.statuses),
    ])
    const items = rows.map((row) => {
      return {
        id: row.id,
        publicId: row.publicId,
        userId: row.userId,
        status: row.status,
        adminNote: row.adminNote,
        userNote: row.userNote,
        reviewedAt: row.reviewedAt,
        reviewedBy: row.reviewedBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        user: {
          id: row.user.id,
          username: row.user.username,
          firstName: row.user.firstName,
          lastName: row.user.lastName,
          name: formatUserName(row.user),
          defaultPublicId: row.user.defaultPublicId?.toString(),
          avatarUrl: row.user.avatarUrl ?? null,
          faceImageUrl: faceImageUrlFromProfile(row.user.faceProfile),
        },
        kycStatus: buildKycReviewStatus(row.kyc, row.user.faceProfile),
      }
    })
    return { items, total, skip: params.skip, take: params.take }
  },

  async getMyApplication(userId: string) {
    const application = await agencyAgentApplicationRepository.findByUserId(userId)
    if (!application) {
      throw new AppError(404, 'No agency application found', 'APPLICATION_NOT_FOUND')
    }
    const { kyc, user } = await agencyApplicationKycRepository.getKycForAdminReview(userId)
    return {
      ...application,
      kycStatus: buildKycReviewStatus(kyc, user?.faceProfile),
    }
  },
}
