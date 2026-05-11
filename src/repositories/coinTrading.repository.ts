import { Prisma } from "@prisma/client";
import { prismaRead } from "../config/database";
import { walletRepository } from "./wallet.repository";
import { WalletCurrencyType } from "@prisma/client";
import { coinLedgerRepository } from "./coin-ledger.repository";

export const coinTradingRepository = {
  getTopupRates() {
    return prismaRead.coinTradingTopupRate.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  },
  getExchangeRates() {
    return prismaRead.agentExchangeRate.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  },
  createTopupOrder(data: Prisma.CoinTradingTopupOrderUncheckedCreateInput, tx: Prisma.TransactionClient) {
    return tx.coinTradingTopupOrder.create({ data });
  },
  updateTopupOrder(
    data: { id: string; epayRef?: string; status?: string; ledgerEntryId?: string },
    tx: Prisma.TransactionClient,
  ) {
    return tx.coinTradingTopupOrder.update({
      where: { id: data.id },
      data: { epayRef: data.epayRef, status: data.status, ledgerEntryId: data.ledgerEntryId },
    });
  },
  getTopupOrderById(id: string) {
    return prismaRead.coinTradingTopupOrder.findUnique({ where: { id } });
  },
  getTopupOrderByEpayRef(ref: string) {
    return prismaRead.coinTradingTopupOrder.findUnique({ where: { epayRef: ref } });
  },
  createTransfer(data: Prisma.CoinTradingTransferUncheckedCreateInput, tx: Prisma.TransactionClient) {
    return tx.coinTradingTransfer.create({ data });
  },
  async reverseTransfer(params: { id: string; reversedByUserId: string; reason: string }, tx: Prisma.TransactionClient) {
    return tx.coinTradingTransfer.update({
      where: { id: params.id },
      data: { reversedAt: new Date(), reversedByUserId: params.reversedByUserId, reverseReason: params.reason },
    });
  },
  getTransferById(id: string) {
    return prismaRead.coinTradingTransfer.findUnique({ where: { id } });
  },
  listTopupOrders(agentUserId: string, opts: { limit: number; cursor?: string }) {
    return prismaRead.coinTradingTopupOrder.findMany({
      where: { agentUserId, ...(opts.cursor ? { id: { lt: opts.cursor } } : {}) },
      orderBy: { createdAt: "desc" },
      take: opts.limit + 1,
    });
  },
  listTransfers(userId: string, opts: { role: "sender" | "recipient" | "all"; limit: number; cursor?: string }) {
    const where =
      opts.role === "sender"
        ? { senderAgentUserId: userId }
        : opts.role === "recipient"
          ? { recipientUserId: userId }
          : { OR: [{ senderAgentUserId: userId }, { recipientUserId: userId }] };
    return prismaRead.coinTradingTransfer.findMany({
      where: { ...where, ...(opts.cursor ? { id: { lt: opts.cursor } } : {}) },
      orderBy: { createdAt: "desc" },
      take: opts.limit + 1,
    });
  },
  async getTradingBalance(userId: string) {
    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.TRADING_COIN);
    return coinLedgerRepository.computeBalance(wallet.id);
  },
};
