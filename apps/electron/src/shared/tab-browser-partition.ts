/**
 * Shared derivation of the ProductSpace-scoped session partition for tab
 * webapps. The renderer (TabShellContext) and the Main process
 * (webview-security) MUST compute the identical name: Main re-derives the
 * partition from its own trusted state (Admin account + committed fence +
 * window workspace) and enforces it at `will-attach-webview` — the renderer
 * never reports the partition itself.
 *
 * The digest is a full SHA-256 (truncated to 128 bits, hex). Persistence
 * isolation is an identity guarantee: a collision would make two different
 * account+ProductSpace+Workspace tuples share cookies and storage, so the
 * earlier 32-bit FNV-1a scheme was replaced after a demonstrable collision
 * between distinct synthetic workspace IDs. `legacyTabAppPartitionForScope`
 * reproduces the superseded name purely so Main can clear the orphaned
 * storage once.
 */

// ---------------------------------------------------------------------------
// Minimal synchronous SHA-256 (works in renderer and Main without Node
// crypto). Standard FIPS 180-4 implementation over UTF-8 bytes.
// ---------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function utf8Bytes(input: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < input.length; index += 1) {
    let codePoint = input.charCodeAt(index)
    // Surrogate pair → code point.
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < input.length) {
      const low = input.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00)
        index += 1
      }
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint < 0x10000) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}

function sha256Hex(input: string): string {
  const message = utf8Bytes(input)
  const bitLength = message.length * 8
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6
  const words = new Uint32Array(paddedLength >> 2)
  for (let index = 0; index < message.length; index += 1) {
    words[index >> 2] |= message[index] << ((3 - (index & 3)) * 8)
  }
  words[message.length >> 2] |= 0x80 << ((3 - (message.length & 3)) * 8)
  words[words.length - 1] = bitLength

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const w = new Uint32Array(64)
  const rotr = (value: number, bits: number) => ((value >>> bits) | (value << (32 - bits))) >>> 0

  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t += 1) w[t] = words[block + t]
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(value => value.toString(16).padStart(8, '0'))
    .join('')
}

export const TAB_APP_PARTITION_PREFIX = 'persist:tab-app-'

/** Superseded 32-bit FNV-1a naming, kept only for Main-side cleanup. */
export const LEGACY_TAB_APP_PARTITION_PREFIX = 'persist:tab-app-fnv-'

function legacyFnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}

/**
 * The scoped partition for one account+ProductSpace+Workspace tuple: the
 * SHA-256 digest is truncated to 128 bits — a 2^-128 collision bound for
 * the identity tuples, so two different tuples never share cookies/storage.
 */
export function tabAppPartitionForScope(input: {
  accountId: string
  productSpaceId: string
  workspaceId: string
}): string {
  // Length-prefixed fields make the encoding unambiguous.
  const encoded = [
    input.accountId.length, input.accountId,
    input.productSpaceId.length, input.productSpaceId,
    input.workspaceId.length, input.workspaceId,
  ].join('\u0000')
  return `${TAB_APP_PARTITION_PREFIX}${sha256Hex(encoded).slice(0, 32)}`
}

/** The superseded partition name (32-bit digest, no workspace dimension). */
export function legacyTabAppPartitionForScope(input: {
  accountId: string
  productSpaceId: string
}): string {
  const encoded = [
    input.accountId.length, input.accountId,
    input.productSpaceId.length, input.productSpaceId,
  ].join('\u0000')
  return `${LEGACY_TAB_APP_PARTITION_PREFIX}${legacyFnv1aHex(encoded)}`
}

/** Matches every scoped tab-app partition (never the assistant pane one). */
export function isTabAppPartition(partition: string | undefined | null): boolean {
  return typeof partition === 'string' && partition.startsWith(TAB_APP_PARTITION_PREFIX)
}
