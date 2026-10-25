#!/usr/bin/env node
/**
 * G2: prove LUCKY_NESTED_PRISMA_GUARD modes in isolated processes (mode fixed at module load).
 *   node tests/ledger/lucky-nested-prisma-guard.modes.mjs
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const TOOLS = join(ROOT, 'docs', 'ops', 'tools')
const dbUrl =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5433/ol_lucky?connection_limit=2&sslmode=disable'

const baseEnv = {
  ...process.env,
  DATABASE_URL: dbUrl,
  JWT_ACCESS_SECRET: 'test-secret-at-least-32-characters-long',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-chars',
  ADMIN_JWT_SECRET: 'test-admin-jwt-secret-at-least-32-chars',
  ADMIN_JWT_REFRESH_SECRET: 'test-admin-refresh-secret-at-least-32-chars',
  LIVE_WEBHOOK_SECRET: 'test-live-webhook-secret-at-least-32-chars',
  INTERNAL_LEDGER_HMAC_SECRET: 'test-internal-ledger-secret-at-least-32-chars',
  AVATAR_CONTENT_MODERATION_ENABLED: 'false',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15',
  LOG_LEVEL: 'warn',
}

function runTs(caseName, script, envExtra) {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const r = spawnSync(cmd, ['tsx', script], {
    cwd: ROOT,
    env: { ...baseEnv, ...envExtra },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) {
    throw new Error(`Case ${caseName} failed status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`)
  }
  const lines = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
  const jsonLine = [...lines].reverse().find((l) => l.startsWith('{'))
  if (!jsonLine) throw new Error(`Case ${caseName}: no JSON line\n${r.stdout}`)
  return JSON.parse(jsonLine)
}

const offIdentity = runTs('off_identity', join(TOOLS, '_g2_off_identity.mts'), {
  NODE_ENV: 'production',
  LUCKY_NESTED_PRISMA_GUARD: 'off',
})
const logBehaviour = runTs('log_behaviour', join(TOOLS, '_g2_log_behaviour.mts'), {
  NODE_ENV: 'development',
  LUCKY_NESTED_PRISMA_GUARD: 'log',
})
const throwBehaviour = runTs('throw_behaviour', join(TOOLS, '_g2_throw_behaviour.mts'), {
  NODE_ENV: 'test',
  LUCKY_NESTED_PRISMA_GUARD: 'throw',
})
const overhead = runTs('overhead', join(TOOLS, '_g2_overhead.mts'), {
  NODE_ENV: 'development',
  LUCKY_NESTED_PRISMA_GUARD: 'log',
})

const results = { offIdentity, logBehaviour, throwBehaviour, overhead }
const pass =
  results.offIdentity.mode === 'off' &&
  results.offIdentity.identity === true &&
  results.offIdentity.hasTx &&
  results.offIdentity.hasExt &&
  results.offIdentity.hasRaw &&
  results.logBehaviour.mode === 'log' &&
  results.logBehaviour.succeeded === true &&
  results.logBehaviour.threw === false &&
  results.logBehaviour.warningHit === true &&
  results.throwBehaviour.mode === 'throw' &&
  results.throwBehaviour.threw === true &&
  results.overhead.N >= 100_000

console.log(JSON.stringify({ pass, results }, null, 2))
process.exit(pass ? 0 : 1)
