import type { AgencyAgentApplicationStatus } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import { agencyAgentApplicationRepository } from '../repositories/agencyAgentApplication.repository'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'

function buildKycReviewStatus(kyc: {
  govtIdSubmittedAt: Date | null
  contactSubmittedAt: Date | null
  faceVerified: boolean
  contactPhone: string | null
  contactEmail: string | null
} | null, faceIndexed: boolean) {
  const faceOk = Boolean(kyc?.faceVerified) || faceIndexed
  return {
    govtIdUploaded: Boolean(kyc?.govtIdSubmittedAt),
    contactSubmitted: Boolean(kyc?.contactSubmittedAt),
    faceVerified: faceOk,
    contactPhone: kyc?.contactPhone ?? null,
    contactEmail: kyc?.contactEmail ?? null,
    isComplete:
      Boolean(kyc?.govtIdSubmittedAt) && Boolean(kyc?.contactSubmittedAt) && faceOk,
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
      const faceIndexed = row.user.faceProfile?.status === 'INDEXED'
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
          defaultPublicId: row.user.defaultPublicId?.toString(),
        },
        kycStatus: buildKycReviewStatus(row.kyc, faceIndexed),
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
    const faceIndexed = user?.faceProfile?.status === 'INDEXED'
    return {
      ...application,
      kycStatus: buildKycReviewStatus(kyc, faceIndexed),
    }
  },
}
