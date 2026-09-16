import { SecureStorageBackend } from '../../backends/secure-storage.ts'

const [credentialsDir] = process.argv.slice(2)
if (!credentialsDir) throw new Error('usage: secure-storage-node-worker <credentials-dir>')

const backend = new SecureStorageBackend({ credentialsDir })
const identity = { type: 'llm_oauth' as const, connectionSlug: 'node-runtime' }
await backend.set(identity, { value: 'node-old', refreshToken: 'node-refresh' })
await backend.compareAndSwap(
  identity,
  { value: 'node-old', refreshToken: 'node-refresh' },
  { value: 'node-rotated', refreshToken: 'node-refresh-rotated' },
)
const afterCas = await backend.get(identity)
const deleted = await backend.delete(identity)
process.stdout.write(JSON.stringify({
  hasBun: 'Bun' in globalThis,
  afterCas: afterCas?.value,
  deleted,
}))
