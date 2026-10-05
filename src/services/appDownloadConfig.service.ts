import { randomUUID } from 'crypto'
import { APP_DOWNLOAD_CONFIG_TTL, redisClient, RedisKeys } from '../config/redis'
import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'
import { appDownloadConfigRepository } from '../repositories/appDownloadConfig.repository'
import { storageService } from './storage.service'
import { extFromFilename } from '../utils/admin-catalog-asset-upload'
import type {
  ApkReleaseCreateBody,
  ApkUploadUrlBody,
  AppLinksUpdateInput,
} from '../models/appDownloadConfig.schemas'

export const APK_CONTENT_TYPE = 'application/vnd.android.package-archive'
/** Slow admin connections need longer than the 300s used for images; the URL only has to be valid when the PUT starts. */
const APK_PRESIGNED_URL_EXPIRES_IN = 900
const ADMIN_RELEASE_LIST_LIMIT = 20
/** `apk/<uuid>/offoolive-<version>.apk` — the last segment is the file name browsers save. */
const APK_KEY_PATTERN = /^apk\/[0-9a-f-]{36}\/offoolive-[0-9A-Za-z._+-]{1,40}\.apk$/

type ReleaseRow = {
  id: string
  s3Key: string
  versionName: string
  sizeBytes: bigint
  createdAt: Date
}

export type ApkReleaseDto = {
  id: string
  versionName: string
  sizeBytes: number
  url: string
  createdAt: string
}

export type AppDownloadAdminDto = {
  iosUrl: string | null
  playStoreUrl: string | null
  currentApk: ApkReleaseDto | null
  releases: ApkReleaseDto[]
  maxApkBytes: number
  updatedAt: string
}

export type AppDownloadPublicDto = {
  ios: string | null
  playStore: string | null
  android: { url: string; versionName: string; sizeBytes: number; uploadedAt: string } | null
}

function serializeRelease(row: ReleaseRow): ApkReleaseDto {
  return {
    id: row.id,
    versionName: row.versionName,
    sizeBytes: Number(row.sizeBytes),
    url: storageService.getCdnOrS3PublicUrl(row.s3Key),
    createdAt: row.createdAt.toISOString(),
  }
}

export const appDownloadConfigService = {
  async getPublicConfig(): Promise<AppDownloadPublicDto> {
    const key = RedisKeys.appDownloadConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) return JSON.parse(hit) as AppDownloadPublicDto
    } catch {
      /* miss */
    }

    const row = await appDownloadConfigRepository.getOrCreate()
    const apk = row.currentApkRelease ? serializeRelease(row.currentApkRelease) : null
    const dto: AppDownloadPublicDto = {
      ios: row.iosUrl,
      playStore: row.playStoreUrl,
      android: apk
        ? {
            url: apk.url,
            versionName: apk.versionName,
            sizeBytes: apk.sizeBytes,
            uploadedAt: apk.createdAt,
          }
        : null,
    }
    try {
      await redisClient.setex(key, APP_DOWNLOAD_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async getAdminConfig(): Promise<AppDownloadAdminDto> {
    const [row, releases] = await Promise.all([
      appDownloadConfigRepository.getOrCreate(),
      appDownloadConfigRepository.listReleases(ADMIN_RELEASE_LIST_LIMIT),
    ])
    return {
      iosUrl: row.iosUrl,
      playStoreUrl: row.playStoreUrl,
      currentApk: row.currentApkRelease ? serializeRelease(row.currentApkRelease) : null,
      releases: releases.map(serializeRelease),
      maxApkBytes: env.APK_MAX_UPLOAD_SIZE_BYTES,
      updatedAt: row.updatedAt.toISOString(),
    }
  },

  async bustCache() {
    await redisClient.del(RedisKeys.appDownloadConfig())
  },

  async updateLinks(adminId: string, input: AppLinksUpdateInput): Promise<AppDownloadAdminDto> {
    await appDownloadConfigRepository.update({
      iosUrl: input.iosUrl,
      playStoreUrl: input.playStoreUrl,
      updatedByAdminId: adminId,
    })
    await appDownloadConfigService.bustCache()
    return appDownloadConfigService.getAdminConfig()
  },

  async getApkUploadUrl(input: ApkUploadUrlBody) {
    if (extFromFilename(input.fileName) !== 'apk') {
      throw new AppError(400, 'Only .apk files can be uploaded', 'INVALID_APK_FILE')
    }
    if (input.sizeBytes > env.APK_MAX_UPLOAD_SIZE_BYTES) {
      throw new AppError(413, 'File exceeds maximum size', 'FILE_TOO_LARGE', {
        maxBytes: env.APK_MAX_UPLOAD_SIZE_BYTES,
      })
    }
    const key = `apk/${randomUUID()}/offoolive-${input.versionName}.apk`
    const uploadUrl = await storageService.getPresignedPutUrl(
      key,
      APK_CONTENT_TYPE,
      APK_PRESIGNED_URL_EXPIRES_IN,
    )
    return {
      uploadUrl,
      key,
      contentType: APK_CONTENT_TYPE,
      expiresIn: APK_PRESIGNED_URL_EXPIRES_IN,
      maxBytes: env.APK_MAX_UPLOAD_SIZE_BYTES,
    }
  },

  /** Called after the browser's PUT finished: verifies the object, records it, and makes it current. */
  async createRelease(adminId: string, input: ApkReleaseCreateBody): Promise<AppDownloadAdminDto> {
    if (!APK_KEY_PATTERN.test(input.key)) {
      throw new AppError(400, 'Invalid APK object key', 'INVALID_APK_KEY')
    }
    if (await appDownloadConfigRepository.findReleaseByKey(input.key)) {
      throw new AppError(409, 'This APK was already saved', 'APK_RELEASE_EXISTS')
    }
    const head = await storageService.headObjectMetadata(input.key)
    if (head.contentLength <= 0 || head.contentLength > env.APK_MAX_UPLOAD_SIZE_BYTES) {
      throw new AppError(400, 'Uploaded APK is empty or too large', 'INVALID_APK_FILE')
    }

    await appDownloadConfigRepository.createReleaseAsCurrent({
      s3Key: input.key,
      versionName: input.versionName,
      sizeBytes: BigInt(head.contentLength),
      adminId,
    })
    await appDownloadConfigService.bustCache()
    return appDownloadConfigService.getAdminConfig()
  },

  /** Rollback / roll forward to any previously uploaded release. */
  async setCurrentRelease(adminId: string, releaseId: string): Promise<AppDownloadAdminDto> {
    const release = await appDownloadConfigRepository.findReleaseById(releaseId)
    if (!release) throw new AppError(404, 'APK release not found', 'APK_RELEASE_NOT_FOUND')
    await appDownloadConfigRepository.update({
      currentApkReleaseId: release.id,
      updatedByAdminId: adminId,
    })
    await appDownloadConfigService.bustCache()
    return appDownloadConfigService.getAdminConfig()
  },
}
