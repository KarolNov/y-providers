import { describe, expect, it } from 'vitest'
import { createFrameReader } from '../core/link.js'
import { decodeFrame, encodeFrame } from '../core/protocol.js'

describe('frames', () => {
  it('round-trips a frame and rejects garbage', () => {
    const f = decodeFrame(encodeFrame('doc-é', 1, new Uint8Array([1, 2, 3])))
    expect(f).toEqual({ doc: 'doc-é', type: 1, payload: new Uint8Array([1, 2, 3]) })
    expect(decodeFrame(new Uint8Array([200]))).toBeNull()
  })

  it('reassembles length-prefixed frames split at any byte, ignoring hellos', () => {
    const big = new Uint8Array(300).fill(7)
    const wire = [
      new Uint8Array([0]),
      new Uint8Array([2, 9, 9]),
      new Uint8Array([0xac, 0x02, ...big]),
    ]
    const bytes = Uint8Array.from(wire.flatMap((w) => [...w]))
    for (let cut = 1; cut < bytes.length; cut++) {
      const got: Uint8Array[] = []
      const read = createFrameReader((f) => got.push(f))
      expect(read(bytes.slice(0, cut))).toBe(true)
      expect(read(bytes.slice(cut))).toBe(true)
      expect(got.map((g) => g.length)).toEqual([2, 300])
    }
  })

  it('reports an absurd length as corruption', () => {
    const read = createFrameReader(() => {})
    expect(read(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]))).toBe(false)
  })
})
