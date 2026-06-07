import { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

export const agencyPointTransferRepository = {
  async insertTransfer(
    row: {
      id: string
      senderAgentUserId: string
      recipientAgentUserId: string
      points: bigint
      senderLedgerEntryId: string
      recipientLedgerEntryId: string
      idempotencyKey: string
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agentPointTransfer.create({
      data: {
        id: row.id,
        senderAgentUserId: row.senderAgentUserId,
        recipientAgentUserId: row.recipientAgentUserId,
        points: row.points,
        senderLedgerEntryId: row.senderLedgerEntryId,
        recipientLedgerEntryId: row.recipientLedgerEntryId,
        idempotencyKey: row.idempotencyKey,
      },
    })
  },

  async getById(id: string) {
    return prismaRead.agentPointTransfer.findUnique({ where: { id } })
  },

  async listForUser(
    userId: string,
    filter: {
      role: 'sender' | 'recipient' | 'all'
      limit: number
      offset: number
    },
  ) {
    const take = filter.limit + 1
    const or: Prisma.AgentPointTransferWhereInput[] = []
    if (filter.role === 'sender' || filter.role === 'all') {
      or.push({ senderAgentUserId: userId })
    }
    if (filter.role === 'recipient' || filter.role === 'all') {
      or.push({ recipientAgentUserId: userId })
    }
    const where: Prisma.AgentPointTransferWhereInput = {
      OR: or.length > 0 ? or : undefined,
    }
    const rows = await prismaRead.agentPointTransfer.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      skip: filter.offset,
    })
    return rows
  },
}
