import { prisma, prismaRead } from '../config/database'

export const adminViewRepository = {
  async findAll() {
    return prismaRead.adminView.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { assignments: true } } },
    })
  },

  async findByName(name: string) {
    return prismaRead.adminView.findUnique({ where: { name } })
  },

  async findByNames(names: string[]) {
    if (names.length === 0) return []
    return prismaRead.adminView.findMany({ where: { name: { in: names } } })
  },

  async create(data: { name: string; endpoints: string[]; createdByAdminId?: string | null }) {
    return prisma.adminView.create({ data })
  },

  async updateEndpoints(id: string, endpoints: string[]) {
    return prisma.adminView.update({ where: { id }, data: { endpoints } })
  },

  /** Assigned views for one admin (ordered by view name). */
  async findAssignedViews(adminId: string) {
    const rows = await prismaRead.adminViewAssignment.findMany({
      where: { adminId },
      include: { view: true },
      orderBy: { view: { name: 'asc' } },
    })
    return rows.map((r) => r.view)
  },

  /** Replace the admin's assignment set atomically. */
  async replaceAssignments(adminId: string, viewIds: string[], assignedByAdminId: string) {
    await prisma.$transaction([
      prisma.adminViewAssignment.deleteMany({ where: { adminId } }),
      prisma.adminViewAssignment.createMany({
        data: viewIds.map((viewId) => ({ adminId, viewId, assignedByAdminId })),
        skipDuplicates: true,
      }),
    ])
  },

  /** Admin ids currently assigned to a view (for targeted cache busts on view edits). */
  async findAssignedAdminIds(viewId: string) {
    const rows = await prismaRead.adminViewAssignment.findMany({
      where: { viewId },
      select: { adminId: true },
    })
    return rows.map((r) => r.adminId)
  },
}
