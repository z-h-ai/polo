import type { ProductSpaceAppIdentity } from '@polo-ai/shared/protocol'
import type { LocalAppDownloadTransport } from './manager'
import { LocalAppRuntimeError } from './runtime-error'

/** Canonical App bytes use a one-use launch nonce AND the current business session. */
export function createProductSpaceDownloadTransport(options: {
  app: ProductSpaceAppIdentity
  kind: 'personal' | 'enterprise'
  adminUrl: string
  downloadUrl: string
  assertCurrent(): void
  readCredentials(): Promise<{ userId: string; accessToken: string } | null>
  fetch?: typeof globalThis.fetch
}): LocalAppDownloadTransport {
  const deny = () => { throw new LocalAppRuntimeError('NOT_AUTHORIZED', 'ProductSpace download authority changed or is invalid') }
  const app = { ...options.app }
  let url: URL
  let admin: URL
  try { url = new URL(options.downloadUrl); admin = new URL(options.adminUrl) } catch { return deny() }
  const expectedPath = options.kind === 'personal'
    ? `/api/personal-entitlements/artifacts/${app.artifactInstanceId}/versions/${app.versionId}/download`
    : `/api/product-spaces/${app.productSpaceId}/artifacts/${app.artifactInstanceId}/versions/${app.versionId}/download`
  const keys = [...url.searchParams.keys()].sort()
  const expectedKeys = options.kind === 'personal' ? ['launch', 'space'] : ['launch']
  const nonce = url.searchParams.get('launch')
  if (admin.protocol !== 'https:' || url.origin !== admin.origin || url.username || url.password
    || url.hash || url.pathname !== expectedPath || JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || !nonce || nonce.length < 16 || nonce.length > 64
    || (options.kind === 'personal' && url.searchParams.get('space') !== app.productSpaceId)) deny()
  const trustedUrl = options.downloadUrl
  const fetchBytes = options.fetch ?? globalThis.fetch
  return {
    assertCurrent: options.assertCurrent,
    async fetch(request, signal) {
      signal.throwIfAborted()
      options.assertCurrent()
      if (request.downloadUrl !== trustedUrl || request.expectedManifestAppId !== app.artifactInstanceId
        || request.version !== app.version) deny()
      const credentials = await options.readCredentials()
      signal.throwIfAborted()
      options.assertCurrent()
      if (!credentials || credentials.userId !== app.accountId || !credentials.accessToken) return deny()
      const response = await fetchBytes(trustedUrl, {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.accessToken}` },
        redirect: 'error', signal,
      })
      try {
        signal.throwIfAborted()
        options.assertCurrent()
        const current = await options.readCredentials()
        signal.throwIfAborted()
        options.assertCurrent()
        if (!current || current.userId !== credentials.userId || current.accessToken !== credentials.accessToken
          || response.redirected || (response.status >= 300 && response.status < 400)
          || (response.url && response.url !== trustedUrl)) deny()
      } catch (error) {
        await response.body?.cancel().catch(() => {})
        throw error
      }
      return response
    },
  }
}
