/**
 * Dev/QA: create a user, complete agency KYC with placeholders (no S3/face APIs),
 * submit agent application, and promote to agency (isAgent + agencies row + TRADING_COIN wallet).
 *
 * Usage:
 *   npx tsx scripts/seed-agency-agent-dev.ts
 *   npx tsx scripts/seed-agency-agent-dev.ts agent-dev@example.com DevPass123!
 *
 * Env: DATABASE_URL, optional AWS_S3_BUCKET (placeholder govt-id bucket), ADMIN_USER_IDS
 * (first UUID used as reviewer; falls back to the new user's id if unset).
 *
 * Login after run: email + password from args (defaults below).
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { env } from "../src/config/env";
import { s3Bucket } from "../src/config/s3";
import { publicIdService } from "../src/services/public-id.service";
import { passwordService } from "../src/services/password.service";
import { agencyApplicationKycRepository } from "../src/repositories/agencyApplicationKyc.repository";
import { agencyKycService } from "../src/services/agencyKyc.service";
import { agencyService } from "../src/services/agency.service";
import { userPublicIdService } from "../src/services/user-public-id.service";

const DEFAULT_EMAIL = "agency-dev-agent@example.com";
const DEFAULT_PASSWORD = "DevAgent123!";

async function main() {
  const email = (process.argv[2] ?? DEFAULT_EMAIL).trim().toLowerCase();
  const password = process.argv[3] ?? DEFAULT_PASSWORD;
  const bucket = s3Bucket?.trim() || "dev-placeholder-bucket";

  const existing = await prisma.authIdentifier.findFirst({
    where: { provider: "email", identifier: email },
    include: { user: true },
  });

  let userId: string;
  let publicId: bigint;

  if (existing) {
    userId = existing.userId;
    publicId = existing.user.publicId;
    console.log(`Using existing user ${userId} (${email}, publicId ${publicId})`);
    if (existing.user.isAgent) {
      const agency = await prisma.agency.findUnique({ where: { userId } });
      console.log(
        JSON.stringify(
          {
            ok: true,
            alreadyAgent: true,
            email,
            userId,
            publicId: publicId.toString(),
            agencyPublicId: agency?.defaultPublicId.toString(),
          },
          null,
          2,
        ),
      );
      return;
    }
  } else {
    const strength = passwordService.validateStrength(password);
    if (!strength.ok) {
      console.error(`Weak password: ${strength.error}`);
      process.exit(1);
    }
    const next = await publicIdService.getNextPublicId("");
    publicId = next.publicId;
    const passwordHash = await passwordService.hash(password);
    const username = email.split("@")[0]!.slice(0, 255);

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          username,
          publicId,
          defaultPublicId: publicId,
          status: "active",
          passwordSet: true,
          profileCompletedAt: new Date(),
          firstName: "Agency",
          lastName: "Dev",
          country: "US",
          gender: "other",
        },
      });
      await tx.authIdentifier.create({
        data: {
          userId: u.id,
          provider: "email",
          identifier: email,
          isVerified: true,
          verifiedAt: new Date(),
          isPrimary: true,
        },
      });
      await tx.authPassword.create({
        data: {
          userId: u.id,
          passwordHash,
          previousPasswordHashes: [],
        },
      });
      return u;
    });

    userId = user.id;
    void userPublicIdService.setOriginalPublicId(userId, publicId).catch(() => {});
    console.log(`Created user ${userId} (${email}, publicId ${publicId})`);
  }

  const placeholderGovtKey = `agency/kyc/${userId}/govt-id/dev-placeholder-${Date.now()}.jpg`;

  await agencyApplicationKycRepository.upsertKycDetails(userId, {
    govtIdS3Key: placeholderGovtKey,
    govtIdS3Bucket: bucket,
    govtIdSubmittedAt: new Date(),
    contactPhone: "+15550001234",
    contactEmail: email,
    contactSubmittedAt: new Date(),
    faceVerified: true,
  });
  console.log("KYC placeholders set (govt id, contact, faceVerified=true)");

  const applyResult = await agencyKycService.applyForAgency(userId);
  const applicationId = applyResult.application.id;
  console.log(
    applyResult.created
      ? `Created agency application ${applicationId}`
      : `Reusing application ${applicationId} (status ${applyResult.application.status})`,
  );

  const adminUserId = env.ADMIN_USER_IDS[0] ?? userId;
  if (!env.ADMIN_USER_IDS[0]) {
    console.warn(
      "ADMIN_USER_IDS not set — using applicant userId as reviewedBy (HTTP admin routes still need a real admin JWT).",
    );
  }

  const promote = await agencyService.createAgencyFromApplication({
    adminUserId,
    applicantUserId: userId,
    applicationId,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        created: promote.created,
        email,
        password: existing ? "(unchanged — user already existed)" : password,
        userId,
        publicId: publicId.toString(),
        agencyPublicId: promote.agency.defaultPublicId.toString(),
        applicationId,
        loginHint: `POST /api/v1/auth/login/password with email ${email}`,
        adminApproveEquivalent: `POST /api/v1/admin/agency/${userId}/approve body { applicationId: "${applicationId}" }`,
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
