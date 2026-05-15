import { AppError } from "../middlewares/errorHandler";
import { agencyAgentApplicationRepository } from "../repositories/agencyAgentApplication.repository";
import { agencyApplicationKycRepository } from "../repositories/agencyApplicationKyc.repository";

export const agencyAgentApplicationService = {
  async getMyApplication(userId: string) {
    const application = await agencyAgentApplicationRepository.findByUserId(userId);
    if (!application) {
      throw new AppError(404, "No agency application found", "APPLICATION_NOT_FOUND");
    }
    const { kyc, user } = await agencyApplicationKycRepository.getKycForAdminReview(userId);
    const faceIndexed = user?.faceProfile?.status === "INDEXED";
    const faceOk = Boolean(kyc?.faceVerified) || Boolean(faceIndexed);
    return {
      ...application,
      kycStatus: {
        govtIdUploaded: Boolean(kyc?.govtIdSubmittedAt),
        contactSubmitted: Boolean(kyc?.contactSubmittedAt),
        faceVerified: faceOk,
        isComplete:
          Boolean(kyc?.govtIdSubmittedAt) &&
          Boolean(kyc?.contactSubmittedAt) &&
          faceOk,
      },
    };
  },
};
