import type { AgencyApplicationKyc } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

type UpsertKycInput = {
  userId: string
  applicationId?: string | null
  govtIdS3Key?: string
  govtIdS3Bucket?: string
  govtIdSubmittedAt?: Date
  contactPhone?: string
  contactEmail?: string
  contactSubmittedAt?: Date
  faceVerified?: boolean
}

/** Relational `create` shape — Prisma `upsert` requires `user: { connect }` here (unchecked `userId`-only create fails validation). */
function buildKycCreate(data: UpsertKycInput): Prisma.AgencyApplicationKycCreateInput {
  const row: Prisma.AgencyApplicationKycCreateInput = {
    user: { connect: { id: data.userId } },
  }
  if (data.applicationId != null && data.applicationId !== '') {
    row.application = { connect: { id: data.applicationId } }
  }
  if (data.govtIdS3Key !== undefined) row.govtIdS3Key = data.govtIdS3Key
  if (data.govtIdS3Bucket !== undefined) row.govtIdS3Bucket = data.govtIdS3Bucket
  if (data.govtIdSubmittedAt !== undefined) row.govtIdSubmittedAt = data.govtIdSubmittedAt
  if (data.contactPhone !== undefined) row.contactPhone = data.contactPhone
  if (data.contactEmail !== undefined) row.contactEmail = data.contactEmail
  if (data.contactSubmittedAt !== undefined) row.contactSubmittedAt = data.contactSubmittedAt
  if (data.faceVerified !== undefined) row.faceVerified = data.faceVerified
  return row
}

export const agencyApplicationKycRepository = {
  async upsertKyc(data: UpsertKycInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    const create = buildKycCreate(data)
    const update: Prisma.AgencyApplicationKycUncheckedUpdateInput = {}
    if (data.applicationId !== undefined) update.applicationId = data.applicationId
    if (data.govtIdS3Key !== undefined) update.govtIdS3Key = data.govtIdS3Key
    if (data.govtIdS3Bucket !== undefined) update.govtIdS3Bucket = data.govtIdS3Bucket
    if (data.govtIdSubmittedAt !== undefined) update.govtIdSubmittedAt = data.govtIdSubmittedAt
    if (data.contactPhone !== undefined) update.contactPhone = data.contactPhone
    if (data.contactEmail !== undefined) update.contactEmail = data.contactEmail
    if (data.contactSubmittedAt !== undefined) update.contactSubmittedAt = data.contactSubmittedAt
    if (data.faceVerified !== undefined) update.faceVerified = data.faceVerified
    return client.agencyApplicationKyc.upsert({
      where: { userId: data.userId },
      create,
      update,
    })
  },

  /** Upsert KYC fields without changing `applicationId` unless explicitly passed. */
  async upsertKycDetails(
    userId: string,
    data: Omit<UpsertKycInput, 'userId'>,
    tx?: Prisma.TransactionClient,
  ) {
    return agencyApplicationKycRepository.upsertKyc({ userId, ...data }, tx)
  },

  async linkApplicationToKyc(userId: string, applicationId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    await client.agencyApplicationKyc.update({
      where: { userId },
      data: { applicationId },
    })
  },

  async getKycByUserId(userId: string): Promise<AgencyApplicationKyc | null> {
    return prismaRead.agencyApplicationKyc.findUnique({ where: { userId } })
  },

  async getKycByUserIdWrite(userId: string): Promise<AgencyApplicationKyc | null> {
    return prisma.agencyApplicationKyc.findUnique({ where: { userId } })
  },

  async getKyc(userId: string) {
    return agencyApplicationKycRepository.getKycByUserId(userId)
  },

  async getKycForAdminReview(userId: string) {
    const [kyc, user] = await Promise.all([
      prismaRead.agencyApplicationKyc.findUnique({ where: { userId } }),
      prismaRead.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          faceProfile: { select: { status: true, s3KeyReference: true } },
        },
      }),
    ])
    return { kyc, user }
  },

  async setFaceVerified(userId: string, verified: boolean) {
    return prisma.agencyApplicationKyc.upsert({
      where: { userId },
      create: {
        user: { connect: { id: userId } },
        faceVerified: verified,
      },
      update: { faceVerified: verified },
    })
  },

  async updateContactByAgentUserId(
    userId: string,
    data: { contactPhone?: string; contactEmail?: string },
  ) {
    const create = buildKycCreate({
      userId,
      ...(data.contactPhone !== undefined ? { contactPhone: data.contactPhone } : {}),
      ...(data.contactEmail !== undefined ? { contactEmail: data.contactEmail } : {}),
      contactSubmittedAt: new Date(),
    })
    const update: Prisma.AgencyApplicationKycUncheckedUpdateInput = {
      contactSubmittedAt: new Date(),
    }
    if (data.contactPhone !== undefined) update.contactPhone = data.contactPhone
    if (data.contactEmail !== undefined) update.contactEmail = data.contactEmail
    return prisma.agencyApplicationKyc.upsert({
      where: { userId },
      create,
      update,
    })
  },
}
