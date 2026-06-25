import { createDecipheriv, hkdfSync } from 'node:crypto'

const transitSalt = 'polo-llm-key-encryption'
const aesGcmInfo = 'aes-256-gcm'
const keyLengthBytes = 32

export function deriveTransitKey(accessToken: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(accessToken, 'utf8'),
      Buffer.from(transitSalt, 'utf8'),
      Buffer.from(aesGcmInfo, 'utf8'),
      keyLengthBytes,
    ),
  )
}

export function decryptTransitApiKey(
  encrypted: { iv: string; ciphertext: string; tag: string },
  transitKey: Buffer,
): string {
  const iv = Buffer.from(encrypted.iv, 'hex')
  const tag = Buffer.from(encrypted.tag, 'hex')
  const ciphertext = Buffer.from(encrypted.ciphertext, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', transitKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
