import { describe, it, expect } from 'vitest'

import { WsFrameRateLimiter, incomingBytesLength } from '../../src/realtime/ws-frame-guard'



describe('WsFrameRateLimiter', () => {

  it('allows bursts under max per second', () => {

    const lim = new WsFrameRateLimiter(5)

    for (let i = 0; i < 5; i++) {

      expect(lim.allow('sock-a')).toBe(true)

    }

    expect(lim.allow('sock-a')).toBe(false)

  })



  it('isolates sockets', () => {

    const lim = new WsFrameRateLimiter(2)

    expect(lim.allow('a')).toBe(true)

    expect(lim.allow('b')).toBe(true)

    expect(lim.allow('a')).toBe(true)

    expect(lim.allow('a')).toBe(false)

  })

})



describe('incomingBytesLength', () => {

  it('counts Buffer and ArrayBuffer', () => {

    expect(incomingBytesLength(Buffer.from('abc'))).toBe(3)

    expect(incomingBytesLength(new ArrayBuffer(4))).toBe(4)

  })

})

