/**
 * Approve an agency agent application (admin promote).
 * Usage: npx tsx scripts/approve-agency-application.ts <applicationId>
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { env } from "../src/config/env";
import { agencyService } from "../src/services/agency.service";

const applicationId = process.argv[2]?.trim();
if (!applicationId) {
  console.error("Usage: npx tsx scripts/approve-agency-application.ts <applicationId>");
  process.exit(1);
}

async function main() {
  const app = await prisma.agencyAgentApplication.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      userId: true,
      status: true,
      user: { select: { username: true, publicId: true, isAgent: true } },
    },
  });
  if (!app) {
    console.error(`Application not found: ${applicationId}`);
    process.exit(1);
  }

  const adminUserId = env.ADMIN_USER_IDS[0];
  if (!adminUserId) {
    console.error("ADMIN_USER_IDS is empty");
    process.exit(1);
  }

  const result = await agencyService.createAgencyFromApplication({
    adminUserId,
    applicantUserId: app.userId,
    applicationId,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        created: result.created,
        agencyPublicId: result.agency.defaultPublicId.toString(),
        userId: app.userId,
        username: app.user.username,
        publicId: app.user.publicId.toString(),
        applicationId,
        previousStatus: app.status,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
