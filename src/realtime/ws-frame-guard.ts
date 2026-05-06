/**

 * Sliding 1s window — cheap in-memory protection against abusive sockets (Phase 4).

 */

export class WsFrameRateLimiter {

  private readonly hits = new Map<string, number[]>()



  constructor(

    private readonly maxPerSec: number,

    private readonly windowMs = 1000,

  ) {}



  /** Returns false when over limit (caller should close the socket). */

  allow(socketKey: string): boolean {

    const now = Date.now()

    let arr = this.hits.get(socketKey)

    if (!arr) {

      arr = []

      this.hits.set(socketKey, arr)

    }

    const cutoff = now - this.windowMs

    while (arr.length > 0 && arr[0]! < cutoff) {

      arr.shift()

    }

    if (arr.length >= this.maxPerSec) return false

    arr.push(now)

    return true

  }



  clear(socketKey: string): void {

    this.hits.delete(socketKey)

  }

}



export function incomingBytesLength(raw: Buffer | ArrayBuffer | Buffer[]): number {

  if (Buffer.isBuffer(raw)) return raw.length

  if (Array.isArray(raw)) {
    let n = 0
    for (const b of raw) {
      n += Buffer.isBuffer(b) ? b.length : (b as ArrayBuffer).byteLength
    }
    return n
  }

  return raw.byteLength

}

