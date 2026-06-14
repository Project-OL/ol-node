import "dotenv/config";
import { prisma } from "../src/config/database";

const userId = process.argv[2] ?? "25029716-25c5-4f7a-8ea6-04a3c8df82b1";

async function main() {
  const wallet = await prisma.wallet.findUnique({
    where: { userId_currencyType: { userId, currencyType: "TRADING_COIN" } },
  });
  if (!wallet) {
    console.log("no TRADING_COIN wallet");
    return;
  }
  const rows = await prisma.coinLedgerEntry.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      direction: true,
      txType: true,
      amount: true,
      balanceAfter: true,
      description: true,
      createdAt: true,
    },
  });
  console.log(
    JSON.stringify(
      rows.map((r) => ({
        ...r,
        amount: r.amount.toString(),
        balanceAfter: r.balanceAfter.toString(),
      })),
      null,
      2,
    ),
  );
}

main()
  .finally(() => prisma.$disconnect());
