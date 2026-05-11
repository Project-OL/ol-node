import { AppError } from "../middlewares/errorHandler";
import { agencyAgentApplicationRepository } from "../repositories/agencyAgentApplication.repository";
import { agencyApplicationKycRepository } from "../repositories/agencyApplicationKyc.repository";
import { userRepository } from "../repositories/user.repository";

export const agencyAgentApplicationService = {
  /**
   * Idempotent — returns existing application unless rejected or already agent.
   */
  async applyOrGet(userId: string) {
    const user = await userRepository.findById(userId);
    if (!user) throw new AppError(404, "User not found", "USER_NOT_FOUND");
    if (user.isAgent) throw new AppError(400, "Already an agent", "ALREADY_AGENT");

    const existing = await agencyAgentApplicationRepository.findByUserId(userId);
    if (existing) {
      if (existing.status === "APPROVED") {
        throw new AppError(400, "Application already approved", "ALREADY_APPROVED");
      }
      if (existing.status === "REJECTED") {
        throw new AppError(
          400,
          "Application was rejected. Contact support to appeal.",
          "APPLICATION_REJECTED",
        );
      }
      return { created: false as const, application: existing };
    }

    const application = await agencyAgentApplicationRepository.create(userId);
    return { created: true as const, application };
  },

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
