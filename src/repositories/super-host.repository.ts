import { prisma, prismaRead } from '../config/database'
import { Prisma } from '@prisma/client'

function isMissingSuperHostsTable(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false
  }
  if (err.code !== 'P2010') {
    return false
  }
  const meta = err.meta as { code?: string; message?: string } | undefined
  return (
    meta?.code === '42P01' ||
    (meta?.message ?? '').includes('relation "super_hosts" does not exist')
  )
}

export const superHostRepository = {
  async isActive(userId: string): Promise<boolean> {
    try {
      const rows = await prismaRead.$queryRaw<Array<{ active: number }>>`
        SELECT 1 AS active
        FROM super_hosts
        WHERE user_id = ${userId}::uuid
          AND revoked_at IS NULL
        LIMIT 1
      `
      return rows.length > 0
    } catch (err) {
      if (isMissingSuperHostsTable(err)) {
        // Backward compatibility: environments without super_hosts should behave
        // as if no user has super-host status instead of failing profile search.
        return false
      }
      throw err
    }
  },

  async grant(userId: string, adminUserId: string): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO super_hosts (user_id, granted_by_user_id, granted_at, revoked_at, revoked_by_user_id)
      VALUES (${userId}::uuid, ${adminUserId}::uuid, NOW(), NULL, NULL)
      ON CONFLICT (user_id)
      DO UPDATE SET
        granted_by_user_id = EXCLUDED.granted_by_user_id,
        granted_at = NOW(),
        revoked_at = NULL,
        revoked_by_user_id = NULL
    `
  },

  async revoke(userId: string, adminUserId: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE super_hosts
      SET revoked_at = NOW(),
          revoked_by_user_id = ${adminUserId}::uuid
      WHERE user_id = ${userId}::uuid
        AND revoked_at IS NULL
    `
  },
}
