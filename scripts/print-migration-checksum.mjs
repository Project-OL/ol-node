/**
 * Print SHA-256 checksum of a migration.sql the same way Prisma stores it in
 * `_prisma_migrations.checksum` (hex string of file bytes — use LF line endings for stable hashes).
 *
 * Usage:
 *   node scripts/print-migration-checksum.mjs prisma/migrations/20260412082101_/migration.sql
 *
 * Then on your database:
 *   UPDATE "_prisma_migrations"
 *   SET "checksum" = '<paste output>'
 *   WHERE "migration_name" = '20260412082101_';
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rel = process.argv[2]
if (!rel) {
  console.error('Usage: node scripts/print-migration-checksum.mjs <path-to-migration.sql>')
  process.exit(1)
}
const buf = readFileSync(resolve(rel))
process.stdout.write(createHash('sha256').update(buf).digest('hex') + '\n')
