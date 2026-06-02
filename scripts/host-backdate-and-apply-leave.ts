/**
 * Dev/QA: set a host's agency join date 2 days back, mark face verification as
 * true, then file a leave application that lands in PENDING state.
 *
 * Why these steps (see agencyHostService.applyToLeave in
 * src/services/agencyHost.service.ts):
 *   immediateLeave = joinedMs < 24h  ||  !faceVerified
 * For the leave to go PENDING (not immediate auto-exit) BOTH must hold:
 *   - membership older than 24h  -> backdate agency_hosts.joined_at (2 days)
 *   - face verified              -> agencyApplicationKyc.faceVerified = true
 * We also backdate any recently-resolved leave application so the 30-day
 * LEAVE_COOLDOWN cannot divert the flow.
 *
 * Usage:
 *   npx tsx scripts/host-backdate-and-apply-leave.ts
 *   npx tsx scripts/host-backdate-and-apply-leave.ts <phone>
 *   npx tsx scripts/host-backdate-and-apply-leave.ts +912222222222
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { agencyApplicationKycRepository } from "../src/repositories/agencyApplicationKyc.repository";
import { agencyHostService } from "../src/services/agencyHost.service";

const DEFAULT_PHONE = "+912222222222";
const COOLDOWN_DAYS = 30;
const BACKDATE_LEAVE_DAYS = 31;

async function main() {
  const phone = (process.argv[2] ?? DEFAULT_PHONE).trim();

  const identifier = await prisma.authIdentifier.findFirst({
    where: { provider: "phone", identifier: phone },
    select: {
      user: { select: { id: true, username: true, publicId: true, currentAgencyId: true } },
    },
  });
  const user = identifier?.user;
  if (!user) {
    console.error(`No user found with phone identifier ${phone}`);
    process.exit(1);
  }
  if (!user.currentAgencyId) {
    console.error(`User ${user.username} is not currently in an agency; cannot apply to leave.`);
    process.exit(1);
  }

  const joinedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  // 1. Backdate the agency join date to 2 days ago.
  const joinUpdate = await prisma.agencyHost.updateMany({
    where: { hostUserId: user.id },
    data: { joinedAt },
  });

  // 2. Mark face verification as true.
  await agencyApplicationKycRepository.setFaceVerified(user.id, true);

  // 3. Defensive: age any recently-resolved leave application past the cooldown window.
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const backdateLeaveTo = new Date(Date.now() - BACKDATE_LEAVE_DAYS * 24 * 60 * 60 * 1000);
  const leaveCooldown = await prisma.agencyLeaveApplication.updateMany({
    where: { hostUserId: user.id, resolvedAt: { gt: cooldownCutoff } },
    data: { resolvedAt: backdateLeaveTo },
  });

  console.log("Host prepared:");
  console.log(`  userId:          ${user.id}`);
  console.log(`  username:        ${user.username}`);
  console.log(`  currentAgencyId: ${user.currentAgencyId}`);
  console.log(`  joined_at set:   ${joinedAt.toISOString()} (rows: ${joinUpdate.count})`);
  console.log(`  faceVerified:    true`);
  console.log(`  leave-cooldown rows aged: ${leaveCooldown.count}`);

  // 4. File the leave application (should land PENDING).
  const result = await agencyHostService.applyToLeave(user.id, "QA: pending leave");

  console.log(`\nLeave application result: ${JSON.stringify(result, null, 2)}`);
  if (result.immediate) {
    console.warn("\nWARNING: leave was IMMEDIATE, not PENDING. Check 24h age / faceVerified gates.");
  } else {
    console.log("\nLeave application is PENDING.");
  }
}

main()
  .catch((err) => {
    console.error("\nFailed:", err?.code ?? "", err?.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
