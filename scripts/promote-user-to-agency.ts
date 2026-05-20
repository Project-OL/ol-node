/**
 * Dev/QA: bypass face KYC gate and promote an existing user to agency.
 *
 * Usage:
 *   npx tsx scripts/promote-user-to-agency.ts <userId>
 *   npx tsx scripts/promote-user-to-agency.ts fbc0640d-05b0-4df9-a9bb-266eb5a0484b
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { env } from "../src/config/env";
import { s3Bucket } from "../src/config/s3";
import { agencyApplicationKycRepository } from "../src/repositories/agencyApplicationKyc.repository";
import { agencyKycService } from "../src/services/agencyKyc.service";
import { agencyService } from "../src/services/agency.service";

async function main() {
  const userId = process.argv[2]?.trim();
  if (!userId) {
    console.error("Usage: npx tsx scripts/promote-user-to-agency.ts <userId>");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      publicId: true,
      isAgent: true,
      username: true,
      authIdentifiers: {
        where: { provider: "email", isPrimary: true },
        select: { identifier: true },
        take: 1,
      },
    },
  });
  if (!user) {
    console.error(`User not found: ${userId}`);
    process.exit(1);
  }

  if (user.isAgent) {
    const agency = await prisma.agency.findUnique({ where: { userId } });
    console.log(
      JSON.stringify(
        {
          ok: true,
          alreadyAgent: true,
          userId: user.id,
          publicId: user.publicId.toString(),
          agencyPublicId: agency?.defaultPublicId.toString(),
        },
        null,
        2,
      ),
    );
    return;
  }

  const email =
    user.authIdentifiers[0]?.identifier ?? `dev-${user.publicId}@placeholder.local`;
  const bucket = s3Bucket?.trim() || "dev-placeholder-bucket";
  const kyc = await agencyApplicationKycRepository.getKycByUserId(userId);

  const patch: Parameters<typeof agencyApplicationKycRepository.upsertKycDetails>[1] = {
    faceVerified: true,
  };
  if (!kyc?.govtIdSubmittedAt) {
    patch.govtIdS3Key = `agency/kyc/${userId}/govt-id/dev-promote-${Date.now()}.jpg`;
    patch.govtIdS3Bucket = bucket;
    patch.govtIdSubmittedAt = new Date();
  }
  if (!kyc?.contactSubmittedAt) {
    patch.contactPhone = kyc?.contactPhone ?? "+15550009999";
    patch.contactEmail = kyc?.contactEmail ?? email;
    patch.contactSubmittedAt = new Date();
  }

  await agencyApplicationKycRepository.upsertKycDetails(userId, patch);
  console.log("KYC updated (faceVerified=true, gaps filled if needed)");

  const applyResult = await agencyKycService.applyForAgency(userId);
  const applicationId = applyResult.application.id;
  console.log(
    applyResult.created
      ? `Application created ${applicationId}`
      : `Application ${applicationId} (${applyResult.application.status})`,
  );

  const adminUserId = env.ADMIN_USER_IDS[0] ?? userId;
  const promote = await agencyService.createAgencyFromApplication({
    adminUserId,
    applicantUserId: userId,
    applicationId,
  });

  const coinseller = await prisma.agencyCoinseller.findUnique({
    where: { agencyUserId: userId },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        created: promote.created,
        userId: user.id,
        publicId: user.publicId.toString(),
        agencyPublicId: promote.agency.defaultPublicId.toString(),
        applicationId,
        whatsappNumber: coinseller?.whatsappNumber ?? null,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
