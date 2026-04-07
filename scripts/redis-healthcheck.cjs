/**
 * Standalone Redis check: loads .env only (does not load full app env Zod schema).
 * Usage: node scripts/redis-healthcheck.cjs
 */
require('dotenv').config()
const Redis = require('ioredis')

const url = process.env.REDIS_URL
if (!url) {
  console.error('FAIL: REDIS_URL is not set in .env')
  process.exit(1)
}

const baseOpts = {
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  lazyConnect: true,
  connectTimeout: 10_000,
  commandTimeout: 5_000,
}

async function check(name, connectionUrl) {
  const client = new Redis(connectionUrl, baseOpts)
  try {
    await client.connect()
    const pong = await client.ping()
    if (pong !== 'PONG') {
      throw new Error(`unexpected PING reply: ${pong}`)
    }
    const testKey = `healthcheck:${Date.now()}`
    await client.set(testKey, 'ok', 'EX', 30)
    const val = await client.get(testKey)
    if (val !== 'ok') {
      throw new Error(`SET/GET mismatch: ${val}`)
    }
    await client.del(testKey)
    console.log(`OK  [${name}] PING=${pong}, SET/GET/DEL succeeded`)
    return true
  } catch (err) {
    console.error(`FAIL [${name}]`, err.message || err)
    return false
  } finally {
    try {
      await client.quit()
    } catch {
      try {
        client.disconnect()
      } catch {
        /* ignore */
      }
    }
  }
}

;(async () => {
  console.log('Redis healthcheck (primary REDIS_URL)')
  const primary = await check('primary', url)
  let readOk = true
  if (process.env.REDIS_READ_URL) {
    console.log('Redis healthcheck (read replica REDIS_READ_URL)')
    readOk = await check('read', process.env.REDIS_READ_URL)
  } else {
    console.log('SKIP [read] REDIS_READ_URL not set')
  }
  process.exit(primary && readOk ? 0 : 1)
})()
