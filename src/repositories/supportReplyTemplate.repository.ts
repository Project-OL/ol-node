import { prisma, prismaRead } from '../config/database'

export const supportReplyTemplateRepository = {
  async create(data: { title: string; content: string; createdByAdminId: string }) {
    return prisma.supportReplyTemplate.create({ data })
  },

  async list() {
    return prismaRead.supportReplyTemplate.findMany({ orderBy: { title: 'asc' } })
  },

  async findById(id: string) {
    return prismaRead.supportReplyTemplate.findUnique({ where: { id } })
  },

  async update(id: string, data: { title?: string; content?: string }) {
    return prisma.supportReplyTemplate.update({ where: { id }, data })
  },

  async remove(id: string) {
    return prisma.supportReplyTemplate.delete({ where: { id } })
  },
}
