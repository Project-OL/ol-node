import { s3Bucket } from "../config/s3";
import { AppError } from "../middlewares/errorHandler";
import { agencyAgentApplicationRepository } from "../repositories/agencyAgentApplication.repository";
import { agencyApplicationKycRepository } from "../repositories/agencyApplicationKyc.repository";
import { storageService } from "./storage.service";

export const agencyKycService = {
  async getPresignedGovtIdUrl(userId: string, mimeType: string) {
    const application = await agencyAgentApplicationRepository.findByUserId(userId);
    if (!application) {
      throw new AppError(
        404,
        "No agency application found. Call POST /agency/kyc/apply first.",
        "APPLICATION_NOT_FOUND",
      );
    }
    if (application.status === "APPROVED" || application.status === "REJECTED") {
      throw new AppError(400, "Application is already resolved", "APPLICATION_RESOLVED");
    }

    const s3Key = `agency/kyc/${userId}/govt-id/${Date.now()}`;
    const uploadUrl = await storageService.getPresignedPutUrl(s3Key, mimeType, 600);
    await agencyApplicationKycRepository.upsertKyc({
      userId,
      applicationId: application.id,
      govtIdS3Key: s3Key,
    });
    return { uploadUrl, s3Key };
  },

  async confirmGovtIdUpload(userId: string, s3Key: string) {
    const bucket = s3Bucket?.trim();
    if (!bucket) {
      throw new AppError(
        503,
        "File storage is not configured",
        "S3_NOT_CONFIGURED",
      );
    }
    const application = await agencyAgentApplicationRepository.findByUserId(userId);
    if (!application) {
      throw new AppError(
        404,
        "No agency application found. Call POST /agency/kyc/apply first.",
        "APPLICATION_NOT_FOUND",
      );
    }
    await agencyApplicationKycRepository.upsertKyc({
      userId,
      applicationId: application.id,
      govtIdS3Key: s3Key,
      govtIdS3Bucket: bucket,
      govtIdSubmittedAt: new Date(),
    });
  },

  async submitContactInfo(userId: string, payload: { phone: string; email: string }) {
    const application = await agencyAgentApplicationRepository.findByUserId(userId);
    if (!application) {
      throw new AppError(
        404,
        "No agency application found. Call POST /agency/kyc/apply first.",
        "APPLICATION_NOT_FOUND",
      );
    }
    await agencyApplicationKycRepository.upsertKyc({
      userId,
      applicationId: application.id,
      contactPhone: payload.phone,
      contactEmail: payload.email,
      contactSubmittedAt: new Date(),
    });
  },

  async getKycStatusForAdmin(userId: string) {
    const row = await agencyApplicationKycRepository.getKycForAdminReview(userId);
    const faceIndexed = row.user?.faceProfile?.status === "INDEXED";
    const faceOk = Boolean(row.kyc?.faceVerified) || faceIndexed;
    return {
      userId,
      govtIdUploaded: Boolean(row.kyc?.govtIdSubmittedAt),
      contactSubmitted: Boolean(row.kyc?.contactSubmittedAt),
      faceVerified: faceOk,
      kyc: row.kyc,
    };
  },

  async validateKycComplete(userId: string) {
    const review = await this.getKycStatusForAdmin(userId);
    const missing: ("GOVT_ID" | "CONTACT_INFO" | "FACE_AUTH")[] = [];
    if (!review.govtIdUploaded) missing.push("GOVT_ID");
    if (!review.contactSubmitted) missing.push("CONTACT_INFO");
    if (!review.faceVerified) missing.push("FACE_AUTH");
    if (missing.length) {
      throw new AppError(422, "KYC incomplete", "KYC_INCOMPLETE", { missing });
    }
  },
};
