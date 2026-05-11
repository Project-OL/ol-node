import { Prisma } from "@prisma/client";
import { prisma, prismaRead } from "../config/database";

type UpsertKycInput = {
  userId: string;
  applicationId: string;
  govtIdS3Key?: string;
  govtIdS3Bucket?: string;
  govtIdSubmittedAt?: Date;
  contactPhone?: string;
  contactEmail?: string;
  contactSubmittedAt?: Date;
  faceVerified?: boolean;
};

function buildKycPayload(data: UpsertKycInput): Prisma.AgencyApplicationKycUncheckedCreateInput {
  const row: Prisma.AgencyApplicationKycUncheckedCreateInput = {
    userId: data.userId,
    applicationId: data.applicationId,
  };
  if (data.govtIdS3Key !== undefined) row.govtIdS3Key = data.govtIdS3Key;
  if (data.govtIdS3Bucket !== undefined) row.govtIdS3Bucket = data.govtIdS3Bucket;
  if (data.govtIdSubmittedAt !== undefined) row.govtIdSubmittedAt = data.govtIdSubmittedAt;
  if (data.contactPhone !== undefined) row.contactPhone = data.contactPhone;
  if (data.contactEmail !== undefined) row.contactEmail = data.contactEmail;
  if (data.contactSubmittedAt !== undefined) row.contactSubmittedAt = data.contactSubmittedAt;
  if (data.faceVerified !== undefined) row.faceVerified = data.faceVerified;
  return row;
}

export const agencyApplicationKycRepository = {
  async upsertKyc(data: UpsertKycInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    const create = buildKycPayload(data);
    const update: Prisma.AgencyApplicationKycUncheckedUpdateInput = {};
    if (data.applicationId !== undefined) update.applicationId = data.applicationId;
    if (data.govtIdS3Key !== undefined) update.govtIdS3Key = data.govtIdS3Key;
    if (data.govtIdS3Bucket !== undefined) update.govtIdS3Bucket = data.govtIdS3Bucket;
    if (data.govtIdSubmittedAt !== undefined) update.govtIdSubmittedAt = data.govtIdSubmittedAt;
    if (data.contactPhone !== undefined) update.contactPhone = data.contactPhone;
    if (data.contactEmail !== undefined) update.contactEmail = data.contactEmail;
    if (data.contactSubmittedAt !== undefined) update.contactSubmittedAt = data.contactSubmittedAt;
    if (data.faceVerified !== undefined) update.faceVerified = data.faceVerified;
    return client.agencyApplicationKyc.upsert({
      where: { userId: data.userId },
      create,
      update,
    });
  },

  async getKyc(userId: string) {
    return prismaRead.agencyApplicationKyc.findUnique({ where: { userId } });
  },

  async getKycForAdminReview(userId: string) {
    const [kyc, user] = await Promise.all([
      prismaRead.agencyApplicationKyc.findUnique({ where: { userId } }),
      prismaRead.user.findUnique({
        where: { id: userId },
        select: { id: true, faceProfile: { select: { status: true } } },
      }),
    ]);
    return { kyc, user };
  },

  async setFaceVerified(userId: string, verified: boolean) {
    return prisma.agencyApplicationKyc.update({
      where: { userId },
      data: { faceVerified: verified },
    });
  },
};
