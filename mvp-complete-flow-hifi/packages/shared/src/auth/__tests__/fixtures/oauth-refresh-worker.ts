import { existsSync, writeFileSync } from 'node:fs'
import { getValidClaudeOAuthTokenWithManager } from '../../state.ts'
import { SecureStorageBackend } from '../../../credentials/backends/secure-storage.ts'

const [credentialsDir, mode, successStarted, allowSuccess, invalidCalled] = process.argv.slice(2)
if (!credentialsDir || !mode || !successStarted || !allowSuccess || !invalidCalled) {
  throw new Error('usage: oauth-refresh-worker <credentials-dir> <mode> <started> <allow> <invalid>')
}

const backend = new SecureStorageBackend({ credentialsDir })
const readOAuth = async (connectionSlug: string) => {
  const credential = await backend.get({ type: 'llm_oauth', connectionSlug })
  if (!credential) return null
  return {
    accessToken: credential.value,
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAt,
    source: credential.source,
  }
}
const manager = {
  getLlmOAuth: readOAuth,
  getPersistedLlmOAuth: readOAuth,
  compareAndSwap: backend.compareAndSwap.bind(backend),
  withExclusiveLease: backend.withExclusiveLease.bind(backend),
}

const result = await getValidClaudeOAuthTokenWithManager(
  'selected-anthropic',
  manager as never,
  async () => {
    if (mode === 'invalid') {
      writeFileSync(invalidCalled, 'called')
      throw new Error('invalid_grant')
    }
    writeFileSync(successStarted, 'started')
    while (!existsSync(allowSuccess)) await new Promise(resolve => setTimeout(resolve, 5))
    return {
      accessToken: 'winner-access-token',
      refreshToken: 'winner-refresh-token',
      expiresAt: Date.now() + 3_600_000,
    }
  },
)

process.stdout.write(JSON.stringify(result))
