/**
 * Dev/QA: make a user apply to (instant-join) an agency, bypassing the 30-day
 * agency-application cooldown.
 *
 * The cooldown (`assertJoinCooldown` in src/services/agencyHost.service.ts) is
 * derived from two tables, both within 30 days of "now":
 *   - agencyHostHistory.exitedAt        (recent exit from an agency)
 *   - agencyHostApplication (REJECTED).resolvedAt
 *
 * We bypass it NON-destructively by backdating any blocking rows to >30 days
 * ago, then calling the real agencyHostService.applyToAgency() so every other
 * invariant (ownership, pause gate, isAgent, already-in-agency) still applies.
 *
 * Usage:
 *   npx tsx scripts/apply-to-agency-bypass-cooldown.ts
 *   npx tsx scripts/apply-to-agency-bypass-cooldown.ts <phone> <agencyPublicId>
 *   npx tsx scripts/apply-to-agency-bypass-cooldown.ts +912222222222 34263426
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { agencyHostService } from "../src/services/agencyHost.service";

const DEFAULT_PHONE = "+912222222222";
const DEFAULT_AGENCY_PUBLIC_ID = "34263426";

const COOLDOWN_DAYS = 30;
const BACKDATE_DAYS = 31; // just past the cooldown window

async function main() {
  const phone = (process.argv[2] ?? DEFAULT_PHONE).trim();
  const agencyPublicId = (process.argv[3] ?? DEFAULT_AGENCY_PUBLIC_ID).trim();

  // 1. Resolve the applicant user by phone auth identifier.
  const identifier = await prisma.authIdentifier.findFirst({
    where: { provider: "phone", identifier: phone },
    select: {
      user: {
        select: { id: true, username: true, publicId: true, isAgent: true, currentAgencyId: true },
      },
    },
  });
  const user = identifier?.user;
  if (!user) {
    console.error(`No user found with phone identifier ${phone}`);
    process.exit(1);
  }

  console.log("Applicant:");
  console.log(`  userId:          ${user.id}`);
  console.log(`  username:        ${user.username}`);
  console.log(`  publicId:        ${user.publicId}`);
  console.log(`  isAgent:         ${user.isAgent}`);
  console.log(`  currentAgencyId: ${user.currentAgencyId ?? "(none)"}`);

  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const backdateTo = new Date(Date.now() - BACKDATE_DAYS * 24 * 60 * 60 * 1000);

  // 2. Backdate blocking cooldown sources (recent exit history).
  const exits = await prisma.agencyHostHistory.updateMany({
    where: { hostUserId: user.id, exitedAt: { gt: cooldownCutoff } },
    data: { exitedAt: backdateTo },
  });

  // 3. Backdate blocking cooldown sources (recent rejected applications).
  const rejects = await prisma.agencyHostApplication.updateMany({
    where: { hostUserId: user.id, status: "REJECTED", resolvedAt: { gt: cooldownCutoff } },
    data: { resolvedAt: backdateTo },
  });

  console.log(
    `\nCooldown bypass: backdated ${exits.count} exit row(s) and ${rejects.count} rejected application(s) to ${backdateTo.toISOString()}`,
  );

  // 4. Run the real instant-join flow (all other guards still enforced).
  const result = await agencyHostService.applyToAgency(user.id, agencyPublicId);

  console.log(
    "\nApplied to agency " +
      agencyPublicId +
      ": " +
      JSON.stringify(result),
  );
}

main()
  .catch((err) => {
    console.error("\nFailed:", err?.code ?? "", err?.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
