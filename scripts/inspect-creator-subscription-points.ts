/**
 * Inspect creator subscription + point ledger for a user id.
 * Usage: npx tsx scripts/inspect-creator-subscription-points.ts <creatorUserId>
 */
import "dotenv/config";
import {
  LedgerDirection,
  PointTxType,
  WalletCurrencyType,
} from "@prisma/client";
import { prisma } from "../src/config/database";

const creatorId =
  process.argv[2] ?? "fbc0640d-05b0-4df9-a9bb-266eb5a0484b";

async function main() {
  const user = await prisma.user.findUnique({
    where: { id: creatorId },
    select: { id: true, username: true, publicId: true },
  });
  console.log("creator", user);

  const subs = await prisma.creatorSubscription.findMany({
    where: { creatorId },
    orderBy: { createdAt: "desc" },
    include: {
      subscriber: { select: { id: true, username: true } },
    },
  });
  console.log(
    "subscriptions",
    subs.map((s) => ({
      id: s.id,
      status: s.status,
      subscriberId: s.subscriberId,
      subscriberUsername: s.subscriber.username,
      createdAt: s.createdAt,
      nextRenewalAt: s.nextRenewalAt,
    })),
  );

  const wallet = await prisma.wallet.findFirst({
    where: { userId: creatorId, currencyType: WalletCurrencyType.POINT },
  });
  if (!wallet) {
    console.log("no point wallet");
    return;
  }

  const subCredits = await prisma.pointLedgerEntry.findMany({
    where: { walletId: wallet.id, txType: PointTxType.SUBSCRIPTION },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log(
    "SUBSCRIPTION point entries",
    subCredits.length,
    subCredits.map((e) => ({
      amount: e.amount.toString(),
      createdAt: e.createdAt,
      counterpartyId: e.counterpartyId,
      idempotencyKey: e.idempotencyKey,
    })),
  );

  const recentCredits = await prisma.pointLedgerEntry.findMany({
    where: { walletId: wallet.id, direction: LedgerDirection.CREDIT },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { txType: true, amount: true, createdAt: true },
  });
  console.log("recent point credits", recentCredits);

  const userSubs = await prisma.userSubscriber.findMany({
    where: { creatorId },
  });
  console.log("user_subscribers rows", userSubs);

  for (const sub of subs.slice(0, 2)) {
    const coinWallet = await prisma.wallet.findFirst({
      where: {
        userId: sub.subscriberId,
        currencyType: WalletCurrencyType.COIN,
      },
    });
    if (!coinWallet) continue;
    const coinDebits = await prisma.coinLedgerEntry.findMany({
      where: {
        walletId: coinWallet.id,
        txType: "CREATOR_SUBSCRIPTION",
        counterpartyId: creatorId,
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    console.log(`subscriber ${sub.subscriber.username} coin debits`, coinDebits.map((e) => ({
      amount: e.amount.toString(),
      createdAt: e.createdAt,
      metadata: e.metadata,
    })));
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
