import { describe, expect, it } from 'bun:test'
import { chmodSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CredentialManager } from '../manager'

describe('R5FIX-01 durable Admin token deletion', () => {
  it('propagates a real owned-directory write failure, then deletes after explicit recovery', async () => {
    const dir = process.env.POLO_AI_CONFIG_DIR!
    expect(homedir()).toBe(process.env.HOME!)
    expect(homedir()).not.toBe('/Users/wow')
    expect(dir.startsWith(homedir() + '/')).toBe(true)
    const manager = new CredentialManager()
    await manager.setAdminTokens({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 60000, userId: 'fixture-user', username: 'fixture-user' })
    const file = readdirSync(dir).find(name => name.endsWith('.enc'))!
    expect(file).toBeTruthy()
    const before = readFileSync(join(dir, file))
    chmodSync(dir, 0o500)
    try {
      await expect(manager.deleteAdminTokens()).rejects.toThrow()
      expect(readFileSync(join(dir, file)).equals(before)).toBe(true)
      expect((await manager.getAdminTokens())?.userId).toBe('fixture-user')
    } finally { chmodSync(dir, 0o700) }
    expect(await manager.deleteAdminTokens()).toBe(true)
    expect(await manager.getAdminTokens()).toBeNull()
  })
})

it('R5FIX-01 never treats an unreadable store as confirmed deletion', async () => {
  const { writeFileSync } = await import('node:fs')
  const dir = process.env.POLO_AI_CONFIG_DIR!
  expect(dir.startsWith(homedir() + '/')).toBe(true)
  const manager = new CredentialManager()
  await manager.setAdminTokens({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
    expiresAt: Date.now() + 60000, userId: 'fixture-user', username: 'fixture-user' })
  const file = join(dir, readdirSync(dir).find(name => name.endsWith('.enc'))!)
  const original = readFileSync(file)
  try {
    writeFileSync(file, 'invalid-encrypted-store')
    await expect(manager.deleteAdminTokens()).rejects.toThrow()
  } finally { writeFileSync(file, original) }
})
