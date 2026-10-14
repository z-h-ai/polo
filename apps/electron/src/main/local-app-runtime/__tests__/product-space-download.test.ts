import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import type { ProductSpaceAppIdentity, LocalAppInstallRequest } from '@polo-ai/shared/protocol'
import { createProductSpaceDownloadTransport } from '../product-space-download'
import { ScopedLocalAppRuntimeRegistry } from '../scoped-registry'

const app: ProductSpaceAppIdentity = {
  accountId: 'account-a', productSpaceId: 'space-a', catalogEntryId: 'entry-a',
  artifactInstanceId: 'artifact-a', versionId: 'version-a', version: '1.0.0', catalogRevision: 'revision-a', sources: [], availability: 'available',
}
const origin = 'https://admin.example'
const personalUrl = `${origin}/api/personal-entitlements/artifacts/artifact-a/versions/version-a/download?space=space-a&launch=issued-nonce-123456`
const enterpriseUrl = `${origin}/api/product-spaces/space-a/artifacts/artifact-a/versions/version-a/download?launch=issued-nonce-123456`
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function fixture(overrides: Record<string, unknown> = {}) {
  let account: { userId: string; accessToken: string } | null = { userId: app.accountId, accessToken: 'current-business-session' }
  let generation = 1
  let calls = 0
  const options = {
    app, kind: 'personal' as const, adminUrl: origin, downloadUrl: personalUrl,
    assertCurrent() { if (generation !== 1) throw new Error('stale context generation') },
    readCredentials: async () => account,
    fetch: (async () => { calls++; return new Response('bytes') }) as unknown as typeof fetch,
    ...overrides,
  }
  const request = {
    appId: 'internal-app', expectedManifestAppId: app.artifactInstanceId,
    version: app.version, downloadUrl: options.downloadUrl,
  } as LocalAppInstallRequest
  return { options, request, calls: () => calls, logout: () => { account = null }, switchAccount: () => { account = { userId: 'account-b', accessToken: 'b' } }, rotate: () => { account = { userId: app.accountId, accessToken: 'new-session' } }, move: () => { generation++ } }
}

describe('trusted ProductSpace bundle transport', () => {
  it('preserves the signed package App identity while storing it under the enterprise instance scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-enterprise-package-identity-')); roots.push(root)
    const source = join(root, 'source'); await mkdir(join(source, 'dist'), { recursive: true })
    const packageAppId = 'original-publisher-app'
    await writeFile(join(source, 'polo-app.json'), JSON.stringify({ schemaVersion: 1, appId: packageAppId, version: app.version, runtime: 'static', entry: ['dist'], healthcheck: '/health', permissions: [] }))
    await writeFile(join(source, 'dist/index.html'), 'original enterprise package bytes')
    const path = join(root, 'bundle.tar.gz'); await tar.c({ cwd: source, file: path, gzip: true }, ['.'])
    const archive = await readFile(path)
    const f = fixture({ kind: 'enterprise', downloadUrl: enterpriseUrl, expectedManifestAppId: packageAppId,
      fetch: async () => new Response(archive, { headers: { 'content-length': String(archive.length) } }) })
    const registry = new ScopedLocalAppRuntimeRegistry({ rootDir: join(root, 'runtime') })
    const scope = { kind: 'catalog' as const, accountId: app.accountId, organizationId: app.productSpaceId, catalogAppId: app.artifactInstanceId }
    const request = { scope, expectedManifestAppId: packageAppId, version: app.version, downloadUrl: enterpriseUrl,
      checksum: createHash('sha256').update(archive).digest('hex'), sizeBytes: archive.length,
      platform: process.platform as 'darwin', arch: process.arch as 'arm64' }
    const installed = await registry.install(request, { downloadTransport: createProductSpaceDownloadTransport(f.options) })
    expect(installed.scope).toEqual(scope)
    expect(installed.currentVersion).toBe(app.version)
    // A substituted package ID still fails before any archive is fetched.
    const substituted = fixture({kind:'enterprise',downloadUrl:enterpriseUrl,expectedManifestAppId:packageAppId})
    await expect(createProductSpaceDownloadTransport(substituted.options).fetch({ ...substituted.request, expectedManifestAppId: 'unrelated-publisher-app' },new AbortController().signal)).rejects.toThrow('authority')
    expect(substituted.calls()).toBe(0)
  })
  for (const kind of ['personal', 'enterprise'] as const) it(`installs real ${kind} archive through registry and manager with authenticated bodyless POST`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-download-boundary-')); roots.push(root)
    const source = join(root, 'source'); await mkdir(join(source, 'dist'), { recursive: true })
    await writeFile(join(source, 'polo-app.json'), JSON.stringify({ schemaVersion: 1, appId: app.artifactInstanceId, version: app.version, runtime: 'static', entry: ['dist'], healthcheck: '/health', webPath: '/', permissions: [] }))
    await writeFile(join(source, 'dist/index.html'), 'real archive bytes')
    const path = join(root, 'bundle.tar.gz'); await tar.c({ cwd: source, file: path, gzip: true }, ['.'])
    const archive = await readFile(path)
    const url = kind === 'personal' ? personalUrl : enterpriseUrl
    const calls: { url: string; init: RequestInit }[] = []
    const f = fixture({ kind, downloadUrl: url, fetch: async (input: string, init: RequestInit) => {
      calls.push({ url: input, init })
      if (init.method !== 'POST' || init.body !== undefined || new Headers(init.headers).get('Authorization') !== 'Bearer current-business-session') return new Response('invalid', { status: 400 })
      return new Response(archive, { headers: { 'content-length': String(archive.length) } })
    } })
    const registry = new ScopedLocalAppRuntimeRegistry({ rootDir: join(root, 'runtime') })
    const result = await registry.install({
      scope: { kind: 'catalog', accountId: app.accountId, organizationId: app.productSpaceId, catalogAppId: app.artifactInstanceId },
      version: app.version, downloadUrl: url, checksum: createHash('sha256').update(archive).digest('hex'), sizeBytes: archive.length,
      platform: process.platform as 'darwin', arch: process.arch as 'arm64',
    }, { downloadTransport: createProductSpaceDownloadTransport(f.options) })
    expect(result.currentVersion).toBe(app.version)
    expect(result.scope?.kind === 'catalog' && result.scope.accountId).toBe(app.accountId)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(url)
    expect(calls[0]!.init.redirect).toBe('error')
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)

    // A complete, checksum-correct stream must not become an installation
    // after logout/switch invalidates the originally captured generation.
    const revoked = fixture({ kind, downloadUrl: url, fetch: async () => new Response(new ReadableStream({
      pull(controller) { revoked.move(); controller.enqueue(archive); controller.close() },
    }, { highWaterMark: 0 }), { headers: { 'content-length': String(archive.length) } }) })
    const revokedRegistry = new ScopedLocalAppRuntimeRegistry({ rootDir: join(root, 'revoked-runtime') })
    const scope = { kind: 'catalog' as const, accountId: app.accountId, organizationId: app.productSpaceId, catalogAppId: app.artifactInstanceId }
    await expect(revokedRegistry.install({
      scope, version: app.version, downloadUrl: url, checksum: createHash('sha256').update(archive).digest('hex'), sizeBytes: archive.length,
      platform: process.platform as 'darwin', arch: process.arch as 'arm64',
    }, { downloadTransport: createProductSpaceDownloadTransport(revoked.options) })).rejects.toThrow('stale context generation')
    expect(await revokedRegistry.readNativeInstallationEvidence(scope)).toEqual({ presence: 'absent', versions: [] })
  })
  for (const [name, url] of Object.entries({
    origin: personalUrl.replace('admin.example', 'attacker.example'),
    userinfo: personalUrl.replace('https://', 'https://evil@'),
    artifact: personalUrl.replace('/artifact-a/', '/artifact-b/'),
    version: personalUrl.replace('/version-a/', '/version-b/'),
    space: personalUrl.replace('space=space-a', 'space=space-b'),
    duplicateSpace: `${personalUrl}&space=space-a`,
    extraQuery: `${personalUrl}&redirect=https://attacker.example`,
    nonce: personalUrl.replace('issued-nonce-123456', 'tiny'),
    fragment: `${personalUrl}#fragment`,
  })) it(`rejects ${name} before credentials or request`, () => {
    const f = fixture({ downloadUrl: url })
    expect(() => createProductSpaceDownloadTransport(f.options)).toThrow('authority')
    expect(f.calls()).toBe(0)
  })
  it('rejects HTTP Admin origin', () => {
    const f = fixture({ adminUrl: 'http://admin.example', downloadUrl: personalUrl.replace('https:', 'http:') })
    expect(() => createProductSpaceDownloadTransport(f.options)).toThrow('authority')
  })
  for (const change of ['logout', 'switchAccount', 'move'] as const) it(`rejects ${change} before fetching`, async () => {
    const f = fixture(); const transport = createProductSpaceDownloadTransport(f.options); f[change]()
    await expect(transport.fetch(f.request, new AbortController().signal)).rejects.toThrow()
    expect(f.calls()).toBe(0)
  })
  it('rejects a request substituted after the trusted grant was created', async () => {
    const f = fixture(); const transport = createProductSpaceDownloadTransport(f.options)
    await expect(transport.fetch({ ...f.request, version: '2.0.0' }, new AbortController().signal)).rejects.toThrow('authority')
    expect(f.calls()).toBe(0)
  })
  for (const change of ['logout', 'rotate', 'move'] as const) it(`cancels returned byte stream when ${change} occurs during fetch`, async () => {
    let cancelled = false
    const f = fixture({ fetch: async () => {
      f[change]()
      return new Response(new ReadableStream({ cancel() { cancelled = true } }))
    } })
    await expect(createProductSpaceDownloadTransport(f.options).fetch(f.request, new AbortController().signal)).rejects.toThrow()
    expect(cancelled).toBe(true)
  })
  it('rejects redirects without visiting the target or forwarding credentials', async () => {
    let requests = 0
    const f = fixture({ fetch: async (_url: string, init: RequestInit) => {
      requests++; expect(init.redirect).toBe('error')
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example' } })
    } })
    await expect(createProductSpaceDownloadTransport(f.options).fetch(f.request, new AbortController().signal)).rejects.toThrow('authority')
    expect(requests).toBe(1)
  })
  it('does not begin a cancelled download', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort()
    await expect(createProductSpaceDownloadTransport(f.options).fetch(f.request, controller.signal)).rejects.toThrow()
    expect(f.calls()).toBe(0)
  })
  it('preserves cancellation of in-flight network I/O', async () => {
    const controller = new AbortController()
    const f = fixture({ fetch: async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal)
      controller.abort()
      init.signal!.throwIfAborted()
      return new Response('unreachable')
    } })
    await expect(createProductSpaceDownloadTransport(f.options).fetch(f.request, controller.signal)).rejects.toThrow()
  })
})
