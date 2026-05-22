/**
 * Live DB check: coin trading transfer/exchange wallet routing.
 *
 * Usage: npx tsx scripts/verify-coin-trading-wallet-debit.ts
 */
import "dotenv/config";
import {
  CoinTxType,
  LedgerDirection,
  PointTxType,
  WalletCurrencyType,
} from "@prisma/client";
import { prisma } from "../src/config/database";
import { coinTradingService } from "../src/services/coinTrading.service";
import { walletRepository } from "../src/repositories/wallet.repository";
import { coinLedgerRepository } from "../src/repositories/coin-ledger.repository";
import { pointLedgerRepository } from "../src/repositories/point-ledger.repository";

const AGENT_PUBLIC_ID = 34216632n; // arctechnovat
const TRANSFER_AMOUNT = 100n;
const EXCHANGE_POINTS = 10_000n;
const RUN_ID = Date.now();

async function seedCoinWallet(
  userId: string,
  currencyType: WalletCurrencyType,
  amount: bigint,
  label: string,
) {
  const wallet = await walletRepository.getOrCreate(userId, currencyType);
  const before = await coinLedgerRepository.computeBalance(wallet.id);
  if (before >= amount) {
    console.log(`  ${label}: already ${before} (skip seed)`);
    return { walletId: wallet.id, before };
  }
  await prisma.$transaction(async (tx) => {
    await walletRepository.lockForUpdate(tx, wallet.id);
    const last = await tx.coinLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    });
    const bal = last?.balanceAfter ?? 0n;
    await coinLedgerRepository.insert(tx, {
      walletId: wallet.id,
      direction: LedgerDirection.CREDIT,
      txType: CoinTxType.ADJUSTMENT,
      amount: amount - bal,
      balanceAfter: amount,
      description: `verify-coin-trading seed ${label}`,
      idempotencyKey: `verify-seed:${userId}:${currencyType}:${RUN_ID}`,
    });
    await walletRepository.bumpVersion(tx, wallet.id);
  });
  const after = await coinLedgerRepository.computeBalance(wallet.id);
  console.log(`  ${label}: seeded to ${after}`);
  return { walletId: wallet.id, before: after };
}

async function seedPointWallet(userId: string, amount: bigint) {
  const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.POINT);
  const before = await pointLedgerRepository.computeBalance(wallet.id);
  if (before >= amount) {
    console.log(`  POINT: already ${before} (skip seed)`);
    return { walletId: wallet.id, before };
  }
  await prisma.$transaction(async (tx) => {
    await walletRepository.lockForUpdate(tx, wallet.id);
    const last = await tx.pointLedgerEntry.findFirst({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    });
    const bal = last?.balanceAfter ?? 0n;
    await tx.pointLedgerEntry.create({
      data: {
        walletId: wallet.id,
        direction: LedgerDirection.CREDIT,
        txType: PointTxType.ADJUSTMENT,
        amount: amount - bal,
        balanceAfter: amount,
        description: "verify-coin-trading seed POINT",
        idempotencyKey: `verify-seed-pt:${userId}:${RUN_ID}`,
      },
    });
    await walletRepository.bumpVersion(tx, wallet.id);
  });
  const after = await pointLedgerRepository.computeBalance(wallet.id);
  console.log(`  POINT: seeded to ${after}`);
  return { walletId: wallet.id, before: after };
}

async function verifyTransfer(agentId: string, recipientPublicId: string) {
  console.log("\n=== Transfer test ===");

  const tradingWallet = await walletRepository.getOrCreate(
    agentId,
    WalletCurrencyType.TRADING_COIN,
  );
  const personalWallet = await walletRepository.getOrCreate(
    agentId,
    WalletCurrencyType.COIN,
  );

  console.log("Seeding agent balances...");
  await seedCoinWallet(agentId, WalletCurrencyType.TRADING_COIN, 10_000n, "TRADING_COIN");
  await seedCoinWallet(agentId, WalletCurrencyType.COIN, 10_000n, "COIN (personal)");

  const tradingBefore = await coinLedgerRepository.computeBalance(tradingWallet.id);
  const personalBefore = await coinLedgerRepository.computeBalance(personalWallet.id);

  await coinTradingService.transferTradingCoins(agentId, {
    recipientPublicId,
    tradingCoins: TRANSFER_AMOUNT,
    idempotencyKey: `verify-transfer-${RUN_ID}`,
  });

  const tradingAfter = await coinLedgerRepository.computeBalance(tradingWallet.id);
  const personalAfter = await coinLedgerRepository.computeBalance(personalWallet.id);

  const lastOut = await prisma.coinLedgerEntry.findFirst({
    where: {
      txType: CoinTxType.TRADING_TRANSFER_OUT,
      wallet: { userId: agentId },
    },
    orderBy: { createdAt: "desc" },
    include: { wallet: { select: { currencyType: true } } },
  });

  const debitedTrading = tradingBefore - tradingAfter === TRANSFER_AMOUNT;
  const debitedPersonal = personalBefore - personalAfter === TRANSFER_AMOUNT;

  console.log(`  TRADING_COIN delta: ${tradingAfter - tradingBefore}`);
  console.log(`  COIN delta:         ${personalAfter - personalBefore}`);
  console.log(`  TRADING_TRANSFER_OUT wallet: ${lastOut?.wallet.currencyType ?? "none"}`);

  if (debitedTrading && !debitedPersonal && lastOut?.wallet.currencyType === "TRADING_COIN") {
    console.log("  PASS: Transfer debited TRADING_COIN only.");
    return true;
  }
  console.log("  FAIL: Transfer did not debit TRADING_COIN correctly.");
  return false;
}

async function verifyExchange(agentId: string) {
  console.log("\n=== Exchange test ===");

  const tradingWallet = await walletRepository.getOrCreate(
    agentId,
    WalletCurrencyType.TRADING_COIN,
  );
  const personalWallet = await walletRepository.getOrCreate(
    agentId,
    WalletCurrencyType.COIN,
  );
  const pointWallet = await walletRepository.getOrCreate(
    agentId,
    WalletCurrencyType.POINT,
  );

  console.log("Seeding agent balances...");
  await seedPointWallet(agentId, EXCHANGE_POINTS + 100_000n);
  const personalBefore = await coinLedgerRepository.computeBalance(personalWallet.id);
  const tradingBefore = await coinLedgerRepository.computeBalance(tradingWallet.id);
  const pointsBefore = await pointLedgerRepository.computeBalance(pointWallet.id);

  await coinTradingService.exchangePointsForTradingCoins(agentId, EXCHANGE_POINTS);

  const personalAfter = await coinLedgerRepository.computeBalance(personalWallet.id);
  const tradingAfter = await coinLedgerRepository.computeBalance(tradingWallet.id);
  const pointsAfter = await pointLedgerRepository.computeBalance(pointWallet.id);

  const lastExchangeCredit = await prisma.coinLedgerEntry.findFirst({
    where: {
      txType: CoinTxType.TRADING_EXCHANGE_FROM_POINTS,
      wallet: { userId: agentId },
    },
    orderBy: { createdAt: "desc" },
    include: { wallet: { select: { currencyType: true } } },
  });

  const pointsDebited = pointsBefore - pointsAfter === EXCHANGE_POINTS;
  const personalUnchanged = personalAfter === personalBefore;
  const tradingIncreased = tradingAfter > tradingBefore;
  const creditedTrading =
    lastExchangeCredit?.wallet.currencyType === "TRADING_COIN";

  console.log(`  POINT delta:        ${pointsAfter - pointsBefore}`);
  console.log(`  TRADING_COIN delta: ${tradingAfter - tradingBefore}`);
  console.log(`  COIN delta:         ${personalAfter - personalBefore}`);
  console.log(
    `  TRADING_EXCHANGE_FROM_POINTS wallet: ${lastExchangeCredit?.wallet.currencyType ?? "none"}`,
  );

  if (pointsDebited && personalUnchanged && tradingIncreased && creditedTrading) {
    console.log("  PASS: Exchange debited POINT and credited TRADING_COIN only.");
    return true;
  }
  console.log("  FAIL: Exchange did not route wallets correctly.");
  return false;
}

async function main() {
  const agent = await prisma.user.findFirst({
    where: { publicId: AGENT_PUBLIC_ID, isAgent: true },
    select: { id: true, username: true, publicId: true },
  });
  if (!agent) throw new Error(`Agent publicId ${AGENT_PUBLIC_ID} not found`);

  const recipient = await prisma.user.findFirst({
    where: { isAgent: false, id: { not: agent.id } },
    select: { id: true, username: true, publicId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!recipient) throw new Error("No non-agent recipient found");

  console.log(`Agent: ${agent.username} (${agent.id})`);
  console.log(`Recipient: ${recipient.username} (${recipient.publicId})`);

  const transferOk = await verifyTransfer(agent.id, recipient.publicId.toString());
  const exchangeOk = await verifyExchange(agent.id);

  console.log("\n=== Overall ===");
  if (transferOk && exchangeOk) {
    console.log("ALL PASS");
  } else {
    console.log("SOME CHECKS FAILED");
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
