/**
 * Bcrypt in a worker thread so the main event loop isn't blocked.
 * Falls back to direct bcrypt when worker isn't available (e.g. dev with tsx).
 */

import { Worker } from 'worker_threads'
import path from 'path'
import fs from 'fs'
import bcrypt from 'bcrypt'

const BCRYPT_ROUNDS = 12

let worker: Worker | null = null

function getWorkerPath(): string | null {
  try {
    const base = path.join(__dirname, '..')
    const candidate = path.join(base, 'workers', 'bcrypt.worker.js')
    if (fs.existsSync(candidate)) return candidate
    return null
  } catch {
    return null
  }
}

function getWorker(): Worker | null {
  if (worker != null) return worker
  const workerPath = getWorkerPath()
  if (!workerPath) return null
  try {
    worker = new Worker(workerPath, { env: process.env })
    return worker
  } catch {
    return null
  }
}

function runInWorker<T>(type: 'hash' | 'compare', plain: string, hash?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const w = getWorker()
    if (!w) {
      if (type === 'hash') {
        bcrypt.hash(plain, BCRYPT_ROUNDS).then(resolve as (v: string) => void).catch(reject)
      } else {
        bcrypt.compare(plain, hash!).then(resolve as (v: boolean) => void).catch(reject)
      }
      return
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const handler = (msg: { id: string; result?: T; error?: string }) => {
      if (msg.id !== id) return
      w.off('message', handler)
      if (msg.error) reject(new Error(msg.error))
      else resolve(msg.result as T)
    }
    w.on('message', handler)
    if (type === 'hash') {
      w.postMessage({ id, type: 'hash', plain })
    } else {
      w.postMessage({ id, type: 'compare', plain, hash })
    }
  })
}

export async function hashAsync(plain: string): Promise<string> {
  return runInWorker<string>('hash', plain)
}

export async function compareAsync(plain: string, hash: string): Promise<boolean> {
  return runInWorker<boolean>('compare', plain, hash)
}
