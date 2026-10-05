import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

const withCurrentApk = { currentApkRelease: true } as const

export const appDownloadConfigRepository = {
  async getOrCreate() {
    return prisma.appDownloadConfig.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
      include: withCurrentApk,
    })
  },

  async update(data: Prisma.AppDownloadConfigUncheckedUpdateInput) {
    await appDownloadConfigRepository.getOrCreate()
    return prisma.appDownloadConfig.update({
      where: { id: 1 },
      data,
      include: withCurrentApk,
    })
  },

  async listReleases(limit: number) {
    return prisma.appApkRelease.findMany({ orderBy: { createdAt: 'desc' }, take: limit })
  },

  async findReleaseById(id: string) {
    return prisma.appApkRelease.findUnique({ where: { id } })
  },

  async findReleaseByKey(s3Key: string) {
    return prisma.appApkRelease.findUnique({ where: { s3Key } })
  },

  /** Inserts the release and makes it current in one transaction. */
  async createReleaseAsCurrent(data: {
    s3Key: string
    versionName: string
    sizeBytes: bigint
    adminId: string
  }) {
    return prisma.$transaction(async (tx) => {
      const release = await tx.appApkRelease.create({
        data: {
          s3Key: data.s3Key,
          versionName: data.versionName,
          sizeBytes: data.sizeBytes,
          uploadedByAdminId: data.adminId,
        },
      })
      await tx.appDownloadConfig.upsert({
        where: { id: 1 },
        create: { id: 1, currentApkReleaseId: release.id, updatedByAdminId: data.adminId },
        update: { currentApkReleaseId: release.id, updatedByAdminId: data.adminId },
      })
      return release
    })
  },
}
