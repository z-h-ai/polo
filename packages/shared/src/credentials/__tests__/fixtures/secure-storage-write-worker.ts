import { SecureStorageBackend } from '../../backends/secure-storage.ts'

const [credentialsDir, connectionSlug, value] = process.argv.slice(2)
if (!credentialsDir || !connectionSlug || !value) {
  throw new Error('usage: secure-storage-write-worker <credentials-dir> <slug> <value>')
}

await new SecureStorageBackend({ credentialsDir }).set(
  { type: 'llm_api_key', connectionSlug },
  { value },
)
