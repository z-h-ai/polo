import { writeFile } from 'node:fs/promises'

import { acquireCredentialWriteLock } from '../../backends/secure-storage.ts'

const [lockPath, readyPath] = process.argv.slice(2)
if (!lockPath || !readyPath) {
  throw new Error('usage: credential-lock-holder <lock-path> <ready-path>')
}

const lock = await acquireCredentialWriteLock(lockPath, {
  timeoutMs: 2_000,
  retryMs: 5,
  heartbeatMs: 60_000,
})
await writeFile(readyPath, JSON.stringify({ lockId: lock.owner.lockId }), { mode: 0o600 })

await new Promise<void>(() => {})
