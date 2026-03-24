/**
 * Worker thread for bcrypt so hashing/comparison don't block the event loop.
 */

import { parentPort } from 'worker_threads'
import bcrypt from 'bcrypt'

const BCRYPT_ROUNDS = 12

interface HashRequest {
  id: string
  type: 'hash'
  plain: string
}

interface CompareRequest {
  id: string
  type: 'compare'
  plain: string
  hash: string
}

type Request = HashRequest | CompareRequest

parentPort?.on('message', async (msg: Request) => {
  try {
    if (msg.type === 'hash') {
      const hash = await bcrypt.hash(msg.plain, BCRYPT_ROUNDS)
      parentPort?.postMessage({ id: msg.id, result: hash })
    } else if (msg.type === 'compare') {
      const match = await bcrypt.compare(msg.plain, msg.hash)
      parentPort?.postMessage({ id: msg.id, result: match })
    }
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: (err as Error).message })
  }
})
