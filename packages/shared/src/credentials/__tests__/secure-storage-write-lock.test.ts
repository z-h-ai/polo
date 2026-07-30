import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecureStorageBackend } from '../backends/secure-storage.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('SecureStorageBackend shared writer lock', () => {
  it('merges concurrent identity updates instead of overwriting the store', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-credential-lock-'))
    tempDirs.push(credentialsDir)
    const first = new SecureStorageBackend({ credentialsDir })
    const second = new SecureStorageBackend({ credentialsDir })

    await Promise.all([
      first.set(
        { type: 'llm_api_key', connectionSlug: 'api' },
        { value: 'api-secret' },
      ),
      second.set(
        { type: 'llm_oauth', connectionSlug: 'oauth' },
        { value: 'access-token', refreshToken: 'refresh-token' },
      ),
    ])

    const verifier = new SecureStorageBackend({ credentialsDir })
    expect(await verifier.get({ type: 'llm_api_key', connectionSlug: 'api' })).toMatchObject({
      value: 'api-secret',
    })
    expect(await verifier.get({ type: 'llm_oauth', connectionSlug: 'oauth' })).toMatchObject({
      value: 'access-token',
      refreshToken: 'refresh-token',
    })
  })
})
