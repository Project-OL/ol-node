/**
 * Rewrite absolute media URLs stored in the database from one object-storage
 * origin to another (S3 -> R2 at the GCP cutover).
 *
 * Why this is needed at all: most media columns store a **bare key** and the API
 * builds the public URL at read time from `S3_PUBLIC_BASE_URL`, so they migrate
 * for free. A minority store the **absolute URL** as it was at write time — those
 * keep pointing at the old S3 origin after cutover and 403 for every user.
 *
 * Object keys carry over unchanged between the two stores, so the rewrite is a
 * pure prefix swap: `{old}/{key}` -> `{new}/{key}`. No parsing, no per-row logic.
 *
 * Columns are discovered from information_schema rather than hardcoded, so a
 * column added later is not silently missed. Only values starting with the old
 * prefix are touched, which also makes the script idempotent — a second run
 * matches nothing.
 *
 * Usage:
 *   npm run media:rewrite-urls -- --dry-run
 *   npm run media:rewrite-urls
 *   npm run media:rewrite-urls -- --from=https://old.example.com --to=https://new.example.com
 */
import 'dotenv/config'
import { prisma } from '../config/database'
import { env } from '../config/env'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ script: 'rewrite-media-urls' })

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`)
const DRY_RUN = hasFlag('dry-run')

/** Trailing slashes are stripped so the swap never produces a `//` in the middle. */
const stripSlash = (s: string) => s.replace(/\/+$/, '')

/** The legacy AWS virtual-hosted origin these rows were written with. */
function defaultFrom(): string {
  const bucket = env.AWS_S3_BUCKET
  const region = env.AWS_REGION
  return `https://${bucket}.s3.${region}.amazonaws.com`
}

/** Where the API serves objects from now — same value the app builds URLs with. */
function defaultTo(): string | undefined {
  return env.S3_PUBLIC_BASE_URL ?? env.CLOUDFRONT_DOMAIN ?? undefined
}

type Candidate = { table: string; column: string }

async function discoverColumns(): Promise<Candidate[]> {
  return prisma.$queryRawUnsafe<Candidate[]>(`
    select table_name as "table", column_name as "column"
      from information_schema.columns
     where table_schema = 'public'
       and data_type in ('text','character varying')
       and (column_name ilike '%url%' or column_name ilike '%image%'
            or column_name ilike '%avatar%' or column_name ilike '%media%'
            or column_name ilike '%photo%' or column_name ilike '%thumbnail%'
            or column_name ilike '%icon%')
     order by table_name, column_name
  `)
}

async function main() {
  const from = stripSlash(argValue('from') ?? defaultFrom())
  const to = stripSlash(argValue('to') ?? defaultTo() ?? '')

  if (!to) {
    log.error(
      'no destination origin — set S3_PUBLIC_BASE_URL (or CLOUDFRONT_DOMAIN), or pass --to=',
    )
    process.exit(1)
  }
  if (from === to) {
    log.info({ from }, 'source and destination origins are identical — nothing to do')
    await prisma.$disconnect()
    return
  }

  log.info({ from, to, dryRun: DRY_RUN }, DRY_RUN ? 'dry run — no writes' : 'applying')

  const candidates = await discoverColumns()
  const like = `${from}/%`
  let totalMatched = 0
  let totalUpdated = 0
  const touched: string[] = []

  for (const { table, column } of candidates) {
    let matched = 0
    try {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `select count(*)::int as n from "${table}" where "${column}" like $1`,
        like,
      )
      matched = rows[0]?.n ?? 0
    } catch {
      // View, unusual type, or a column we have no business touching — skip it
      // rather than abort a cutover step over one non-table relation.
      continue
    }
    if (matched === 0) continue

    totalMatched += matched
    touched.push(`${table}.${column} (${matched})`)

    if (DRY_RUN) {
      log.info({ table, column, rows: matched }, 'would rewrite')
      continue
    }

    const updated = await prisma.$executeRawUnsafe(
      `update "${table}"
          set "${column}" = $1 || substring("${column}" from ${from.length + 1})
        where "${column}" like $2`,
      to,
      like,
    )
    totalUpdated += updated
    log.info({ table, column, rows: updated }, 'rewritten')
  }

  log.info(
    { columns: touched.length, matched: totalMatched, updated: totalUpdated, dryRun: DRY_RUN },
    'done',
  )
  if (touched.length > 0) log.info({ touched }, 'columns affected')

  if (!DRY_RUN) {
    // A leftover means a value that starts with the old origin survived the
    // update — worth failing loudly during a cutover rather than discovering it
    // from user reports.
    let leftover = 0
    for (const { table, column } of candidates) {
      try {
        const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
          `select count(*)::int as n from "${table}" where "${column}" like $1`,
          like,
        )
        leftover += rows[0]?.n ?? 0
      } catch {
        continue
      }
    }
    log.info({ leftover }, leftover === 0 ? 'verified: no old-origin urls remain' : 'LEFTOVERS')
    if (leftover > 0) process.exitCode = 1
  }

  await prisma.$disconnect()
}

main().catch(async (err) => {
  log.error({ err }, 'fatal')
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
