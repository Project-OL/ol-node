#!/usr/bin/env node
/**
 * Bench v2: 6x send-otp (sequential), 1x verify-otp (with OTP from server console), 1x send-otp (7th).
 * Usage: node scripts/send-otp-bench-v2.js [otp]
 *   If [otp] omitted, verify step is skipped; get OTP from server console (DEV OTP [phone] ...: 123456) after the 6 sends.
 * Requires server running (e.g. npm run dev). Node 18+ for fetch.
 */

const PORT = Number(process.env.PORT) || 3000
const BASE = `http://127.0.0.1:${PORT}`
const SEND_BODY = { provider: 'phone', identifier: '+919999999999' }

async function post(path, body) {
  const start = performance.now()
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const elapsed = performance.now() - start
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, elapsed, data, text }
}

function printTable(rows) {
  const widths = [10, 12, 10, 14]
  const pad = (s, w) => String(s).slice(0, w).padEnd(w)
  console.log('\n' + pad('#', widths[0]) + pad('Type', widths[1]) + pad('Status', widths[2]) + pad('Time (ms)', widths[3]))
  console.log('-'.repeat(widths[0] + widths[1] + widths[2] + widths[3]))
  rows.forEach((r) => {
    console.log(pad(r.idx, widths[0]) + pad(r.type, widths[1]) + pad(r.status, widths[2]) + pad(r.elapsed.toFixed(2), widths[3]))
  })
  console.log('')
}

async function main() {
  const otpArg = process.argv[2]
  const results = []
  let idx = 0

  console.log('1. Sending 6x POST /api/v1/auth/send-otp sequentially...')
  for (let i = 0; i < 6; i++) {
    idx++
    const r = await post('/api/v1/auth/send-otp', SEND_BODY)
    results.push({ idx, type: 'send-otp', status: r.status, elapsed: r.elapsed, raw: r })
    if (r.status !== 200) {
      console.error(`Send #${idx} failed (${r.status}):`, r.text)
    }
  }

  if (otpArg) {
    console.log('2. Sending 1x POST /api/v1/auth/verify-otp with OTP from arg...')
    idx++
    const r = await post('/api/v1/auth/verify-otp', {
      provider: 'phone',
      identifier: '+919999999999',
      otp: otpArg,
    })
    results.push({ idx, type: 'verify-otp', status: r.status, elapsed: r.elapsed, raw: r })
    if (r.status !== 200) {
      console.error(`Verify failed (${r.status}):`, r.text)
    }
  } else {
    console.log('2. Skipping verify (no OTP). Run with: node scripts/send-otp-bench-v2.js <otp>')
    console.log('   Get OTP from server console: DEV OTP [phone] +919999999999: <otp>')
  }

  console.log('3. Sending 7th POST /api/v1/auth/send-otp (rate limit should allow)...')
  idx++
  const r7 = await post('/api/v1/auth/send-otp', SEND_BODY)
  results.push({ idx, type: 'send-otp', status: r7.status, elapsed: r7.elapsed, raw: r7 })
  if (r7.status !== 200) {
    console.error('7th send failed:', r7.text)
  }

  printTable(results.map((r) => ({ idx: r.idx, type: r.type, status: r.status, elapsed: r.elapsed })))

  const send6 = results.filter((r) => r.type === 'send-otp' && r.idx <= 6)
  const verify = results.find((r) => r.type === 'verify-otp')
  const send7 = results.find((r) => r.type === 'send-otp' && r.idx === 7)

  const allSend6Ok = send6.length === 6 && send6.every((r) => r.status === 200)
  const verifyOk = !verify || verify.status === 200
  const send7Ok = send7 && send7.status === 200

  if (!allSend6Ok) {
    console.error('Check failed: not all 6 send requests returned 200')
    send6.filter((r) => r.status !== 200).forEach((r) => console.error('  Response:', r.raw.text))
  }
  if (verify && !verifyOk) {
    console.error('Check failed: verify did not return 200. Response:', verify.raw.text)
  }
  if (!send7Ok) {
    console.error('Check failed: 7th send did not return 200 (rate limit may be blocking). Response:', send7?.raw?.text)
  }

  if (allSend6Ok && verifyOk && send7Ok) {
    console.log('All checks passed.')
  } else {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
