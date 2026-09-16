const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/**
 * Incremental SHA-256 following NIST FIPS 180-4. It exists in the renderer so
 * a 100 MiB upload can be hashed in bounded chunks without buffering the whole
 * archive or depending on Node crypto in the isolated renderer bundle.
 *
 * Word loads and the final 64-bit bit length are big-endian as required by the
 * standard. Every state/schedule addition uses `>>> 0` to retain JavaScript's
 * unsigned 32-bit modular arithmetic. The caller's 100 MiB hard cap keeps the
 * byte/bit counters well inside Number's exact-integer range.
 */
export class IncrementalSha256 {
  private readonly state = new Uint32Array(SHA256_INITIAL_STATE)
  private readonly buffer = new Uint8Array(64)
  private readonly schedule = new Uint32Array(64)
  private bufferLength = 0
  private bytesHashed = 0
  private finished = false

  update(bytes: Uint8Array): void {
    if (this.finished) throw new Error('SHA-256 digest is already finalized')
    this.bytesHashed += bytes.byteLength
    let offset = 0
    if (this.bufferLength > 0) {
      const copied = Math.min(64 - this.bufferLength, bytes.byteLength)
      this.buffer.set(bytes.subarray(0, copied), this.bufferLength)
      this.bufferLength += copied
      offset = copied
      if (this.bufferLength === 64) {
        this.processBlock(this.buffer, 0)
        this.bufferLength = 0
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.processBlock(bytes, offset)
      offset += 64
    }
    if (offset < bytes.byteLength) {
      const remainder = bytes.subarray(offset)
      this.buffer.set(remainder)
      this.bufferLength = remainder.byteLength
    }
  }

  digestHex(): string {
    if (this.finished) throw new Error('SHA-256 digest is already finalized')
    this.finished = true
    const tailLength = this.bufferLength < 56 ? 64 : 128
    const tail = new Uint8Array(tailLength)
    tail.set(this.buffer.subarray(0, this.bufferLength))
    tail[this.bufferLength] = 0x80
    const bitLength = this.bytesHashed * 8
    const view = new DataView(tail.buffer)
    view.setUint32(tailLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
    view.setUint32(tailLength - 4, bitLength >>> 0, false)
    for (let offset = 0; offset < tailLength; offset += 64) {
      this.processBlock(tail, offset)
    }
    return Array.from(this.state, value => value.toString(16).padStart(8, '0')).join('')
  }

  private processBlock(bytes: Uint8Array, offset: number): void {
    const schedule = this.schedule
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4
      schedule[index] = (
        (bytes[start]! << 24)
        | (bytes[start + 1]! << 16)
        | (bytes[start + 2]! << 8)
        | bytes[start + 3]!
      ) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const before15 = schedule[index - 15]!
      const before2 = schedule[index - 2]!
      const sigma0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3)
      const sigma1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10)
      schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0
    }

    let a = this.state[0]!
    let b = this.state[1]!
    let c = this.state[2]!
    let d = this.state[3]!
    let e = this.state[4]!
    let f = this.state[5]!
    let g = this.state[6]!
    let h = this.state[7]!
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    this.state[0] = (this.state[0]! + a) >>> 0
    this.state[1] = (this.state[1]! + b) >>> 0
    this.state[2] = (this.state[2]! + c) >>> 0
    this.state[3] = (this.state[3]! + d) >>> 0
    this.state[4] = (this.state[4]! + e) >>> 0
    this.state[5] = (this.state[5]! + f) >>> 0
    this.state[6] = (this.state[6]! + g) >>> 0
    this.state[7] = (this.state[7]! + h) >>> 0
  }
}
