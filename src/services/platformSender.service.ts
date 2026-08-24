import { prisma } from '../config/database'
import { env } from '../config/env'
import { publicIdRepository } from '../repositories/public-id.repository'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'platform-sender' })

/** Stable username for the auto-provisioned inbox sender (not used for login). */
export const PLATFORM_SENDER_USERNAME = 'offoo_platform'

/**
 * Resolves the user row that sends SYSTEM / NOTIFICATION / TRANSACTIONAL inbox messages.
 * Auto-creates `offoo_platform` when none exists — admins never need a manual support-user seed.
 */
export async function getOrCreatePlatformSenderUser(): Promise<{ id: string }> {
  const configuredId = env.PLATFORM_SENDER_USER_ID?.trim()
  if (configuredId) {
    const configured = await prisma.user.findUnique({
      where: { id: configuredId },
      select: { id: true, status: true },
    })
    if (configured) {
      if (configured.status !== 'active') {
        await prisma.user.update({
          where: { id: configured.id },
          data: { status: 'active', isSupport: true },
        })
      }
      return { id: configured.id }
    }
    log.warn({ configuredId }, 'PLATFORM_SENDER_USER_ID not found; auto-provisioning sender')
  }

  const activeSupport = await prisma.user.findFirst({
    where: { isSupport: true, status: 'active' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (activeSupport) return activeSupport

  const anySupport = await prisma.user.findFirst({
    where: { isSupport: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (anySupport) {
    await prisma.user.update({
      where: { id: anySupport.id },
      data: { status: 'active' },
    })
    return anySupport
  }

  const existingByUsername = await prisma.user.findFirst({
    where: { username: PLATFORM_SENDER_USERNAME },
    select: { id: true },
  })
  if (existingByUsername) {
    await prisma.user.update({
      where: { id: existingByUsername.id },
      data: { isSupport: true, status: 'active' },
    })
    return existingByUsername
  }

  const publicId = await publicIdRepository.getNextAndIncrement()
  try {
    const created = await prisma.user.create({
      data: {
        username: PLATFORM_SENDER_USERNAME,
        publicId,
        defaultPublicId: publicId,
        originalPublicId: publicId,
        status: 'active',
        isSupport: true,
        firstName: 'Offoo',
        lastName: 'Platform',
      },
      select: { id: true },
    })

    log.info(
      { userId: created.id, publicId: publicId.toString() },
      'auto-provisioned platform sender user',
    )
    return created
  } catch (err) {
    const raced = await prisma.user.findFirst({
      where: { username: PLATFORM_SENDER_USERNAME },
      select: { id: true },
    })
    if (raced) {
      await prisma.user.update({
        where: { id: raced.id },
        data: { isSupport: true, status: 'active' },
      })
      return raced
    }
    throw err
  }
}
