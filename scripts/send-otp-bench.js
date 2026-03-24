#!/usr/bin/env node
/**
 * Run send-otp 6 times, then print average timings from docs/send-otp-timings.jsonl (last 6 lines).
 * Start the server first (e.g. npm run dev), then: node scripts/send-otp-bench.js
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.PORT) || 3000
const BASE_URL = `http://127.0.0.1:${PORT}`
const RUNS = 6
const TIMINGS_FILE = path.join(process.cwd(), 'docs', 'send-otp-timings.jsonl')

function request(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const opts = {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/v1/auth/send-otp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }
    const req = http.request(opts, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${buf}`))
        else resolve(buf)
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function main() {
  console.log(`Sending ${RUNS} POST requests to ${BASE_URL}/api/v1/auth/send-otp ...`)
  for (let i = 0; i < RUNS; i++) {
    try {
      await request({ provider: 'phone', identifier: `+1555000${i}` })
      console.log(`  Run ${i + 1}/${RUNS} OK`)
    } catch (e) {
      console.error(`  Run ${i + 1} failed:`, e.message)
      process.exit(1)
    }
  }

  if (!fs.existsSync(TIMINGS_FILE)) {
    console.error('Timings file not found:', TIMINGS_FILE)
    process.exit(1)
  }

  const lines = fs.readFileSync(TIMINGS_FILE, 'utf8').trim().split('\n').filter(Boolean)
  const last = lines.slice(-RUNS)
  if (last.length === 0) {
    console.error('No timing lines in file.')
    process.exit(1)
  }

  const parsed = last.map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return {}
    }
  })

  const keys = [
    'redis_get',
    'otp_generate',
    'otp_hash',
    'redis_store',
    'db_create',
    'db_invalidate',
    'createAndStoreOtp_total',
    'redis_incr',
    'redis_expire',
    'total_ms',
  ]

  const sums = {}
  const counts = {}
  for (const row of parsed) {
    for (const k of keys) {
      if (typeof row[k] === 'number') {
        sums[k] = (sums[k] || 0) + row[k]
        counts[k] = (counts[k] || 0) + 1
      }
    }
  }

  console.log('\n--- Average time per step (ms) over ' + last.length + ' runs ---\n')
  const stepLabels = {
    redis_get: 'Redis GET (rate limit check)',
    otp_generate: 'OTP generate (crypto.randomInt)',
    otp_hash: 'OTP hash (HMAC-SHA256)',
    redis_store: 'Redis SET (OTP payload)',
    db_create: 'DB INSERT (otp_verifications)',
    db_invalidate: 'DB UPDATE (invalidate previous)',
    createAndStoreOtp_total: 'createAndStoreOtp (total)',
    redis_incr: 'Redis INCR',
    redis_expire: 'Redis EXPIRE',
    total_ms: 'sendOtpUnified (total)',
  }
  const results = []
  for (const k of keys) {
    const n = counts[k] || 0
    const avg = n ? Number((sums[k] / n).toFixed(2)) : null
    const label = stepLabels[k] || k
    console.log(`  ${label}: ${avg != null ? avg + ' ms' : '—'} (${n} runs)`)
    results.push({ step: k, label: stepLabels[k] || k, avg_ms: avg, runs: n })
  }
  console.log('\n(Copy the table below into docs/send-otp-flow.md if needed.)\n')
  console.log('| Step | DB | Redis | Actual avg (ms) |')
  console.log('|------|----|-------|-----------------|')
  const dbSteps = ['db_create', 'db_invalidate']
  const redisSteps = ['redis_get', 'redis_store', 'redis_incr', 'redis_expire']
  for (const r of results) {
    if (r.step === 'total_ms' || r.step === 'createAndStoreOtp_total') continue
    const db = dbSteps.includes(r.step) ? 'Yes' : '—'
    const redis = redisSteps.includes(r.step) ? 'Yes' : '—'
    const avg = r.avg_ms != null ? r.avg_ms : '—'
    console.log('| ' + r.label + ' | ' + db + ' | ' + redis + ' | ' + avg + ' |')
  }
  const totalRow = results.find((r) => r.step === 'total_ms')
  if (totalRow && totalRow.avg_ms != null) {
    console.log('| **sendOtpUnified (total)** | — | — | **' + totalRow.avg_ms + '** |')
  }
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
