import { describe, expect, it } from 'bun:test'
import {
  analyzeCreatorAppPayload,
  buildCreatorAppPublishingUrl,
  CREATOR_APP_CANONICAL_ENTRIES,
  CREATOR_APP_PAYLOAD_LIMITS,
  createCanonicalCreatorAppBundle,
  createPlatformOwnedManifest,
  decodeCreatorAppPayloadZip,
  resolveCreatorAppPublishingOrganization,
  validateProductionCreatorAppBundle,
} from '../creator-app-publishing.ts'
import { unzipSync, zipSync } from 'fflate'
import { CREATOR_APP_PAYLOAD_FIXTURES } from './creator-app-publishing.fixtures.ts'

const dynamicRuntimeEvidence = `
const host = process.env.HOST;
const port = process.env.PORT;
const health = "/health";
const token = process.env.POLO_APP_HEALTH_TOKEN;
const header = "X-Polo-App-Health-Token";
`

describe('Creator App publishing contract', () => {
  it('recognizes a static production payload and produces a platform-owned manifest', () => {
    const result = analyzeCreatorAppPayload([
      { path: 'index.html', content: '<!doctype html>' },
      { path: 'assets/app.js', content: 'console.log(1)' },
    ])
    expect(result).toEqual({
      status: 'ready',
      candidate: { runtime: 'static', path: 'index.html' },
    })

    const manifest = createPlatformOwnedManifest({
      appId: 'server-app-id',
      version: '1.0.0',
      name: 'Static App',
      entry: result.status === 'ready' ? result.candidate : { runtime: 'static', path: 'index.html' },
    })
    expect(manifest).toMatchObject({
      appId: 'server-app-id',
      version: '1.0.0',
      runtime: 'static',
      entry: ['index.html'],
      permissions: [],
    })
  })

  it('recognizes the canonical locked Python and JS service payloads without executing them', () => {
    expect(analyzeCreatorAppPayload([
      { path: 'server/main.py', content: dynamicRuntimeEvidence },
      { path: 'pyproject.toml', content: '[project]\nname = "app"' },
      { path: 'uv.lock', content: '# lock marker' },
    ])).toEqual({
      status: 'ready',
      candidate: { runtime: 'python', path: 'server/main.py' },
    })
    expect(analyzeCreatorAppPayload([
      { path: 'server/index.js', content: dynamicRuntimeEvidence },
      { path: 'package.json', content: '{"name":"app"}' },
      { path: 'bun.lock', content: '{"workspaces":{}}' },
    ])).toEqual({
      status: 'ready',
      candidate: { runtime: 'js', path: 'server/index.js' },
    })
  })

  it('asks only for an entry when more than one runnable service is found', () => {
    expect(analyzeCreatorAppPayload([
      { path: 'app.py', content: dynamicRuntimeEvidence },
      { path: 'server.py', content: dynamicRuntimeEvidence },
      { path: 'pyproject.toml', content: '[project]\nname = "app"' },
      { path: 'uv.lock', content: '# lock marker' },
    ])).toEqual({
      status: 'needs_entry_selection',
      candidates: [
        { runtime: 'python', path: 'app.py' },
        { runtime: 'python', path: 'server.py' },
      ],
    })
  })

  it('blocks contradictory runtimes instead of asking the Creator to choose a runtime', () => {
    expect(analyzeCreatorAppPayload([
      { path: 'index.html', content: '<!doctype html>' },
      { path: 'server/main.py', content: dynamicRuntimeEvidence },
      { path: 'pyproject.toml', content: '[project]\nname = "app"' },
      { path: 'uv.lock', content: '# lock marker' },
    ])).toMatchObject({ status: 'invalid', code: 'ambiguous_runtime' })
  })

  it('prefers a canonical entry over compatible root-level legacy entries', () => {
    expect(analyzeCreatorAppPayload([
      { path: 'server/main.py', content: dynamicRuntimeEvidence },
      { path: 'app.py', content: dynamicRuntimeEvidence },
      { path: 'pyproject.toml', content: '[project]\nname = "app"' },
      { path: 'uv.lock', content: '# lock marker' },
    ])).toEqual({
      status: 'ready',
      candidate: { runtime: 'python', path: 'server/main.py' },
    })
  })

  it('rejects unsafe archives and gives a result-oriented error for source-only uploads', () => {
    expect(analyzeCreatorAppPayload([{ path: '../escape.py' }])).toMatchObject({
      status: 'invalid',
      code: 'unsafe_archive',
    })
    expect(analyzeCreatorAppPayload([{ path: 'linked-app', type: 'symlink' }])).toMatchObject({
      status: 'invalid',
      code: 'unsafe_archive',
    })
    expect(analyzeCreatorAppPayload([{ path: 'src/index.ts' }])).toMatchObject({
      status: 'invalid',
      code: 'missing_runnable_payload',
      message: expect.stringContaining('POL-65'),
    })
  })

  it('rejects legacy Manifest permission objects and non-empty arrays instead of rewriting them', () => {
    for (const permissions of [{ shell: true }, ['shell']]) {
      expect(analyzeCreatorAppPayload([
        { path: 'index.html', content: '<!doctype html>' },
        { path: 'polo-app.json', content: JSON.stringify({ runtime: 'static', entry: ['index.html'], permissions }) },
      ])).toMatchObject({ status: 'invalid', code: 'invalid_legacy_permissions' })
    }
  })

  it('does not accept an empty dependency lock or a service without a health endpoint', () => {
    expect(analyzeCreatorAppPayload([
      { path: 'server/main.py', content: dynamicRuntimeEvidence },
      { path: 'pyproject.toml', content: '[project]\nname = "app"' },
      { path: 'uv.lock', content: '' },
    ])).toMatchObject({ status: 'invalid', code: 'missing_runnable_payload' })
    expect(analyzeCreatorAppPayload([
      { path: 'server/index.js', content: dynamicRuntimeEvidence },
      { path: 'package.json', content: '{"name":"app"}' },
      { path: 'bun.lock', content: '' },
    ])).toMatchObject({ status: 'invalid', code: 'missing_runnable_payload' })
    expect(analyzeCreatorAppPayload([
      { path: 'server/index.js', content: 'server.listen(3000)' },
      { path: 'package.json', content: '{"name":"app"}' },
      { path: 'bun.lock', content: '{"workspaces":{}}' },
    ])).toMatchObject({ status: 'invalid', code: 'missing_runnable_payload' })
  })

  it('accepts all four compliance fixtures through ZIP analysis and final Bundle validation', () => {
    for (const fixture of CREATOR_APP_PAYLOAD_FIXTURES) {
      const payloadArchive = zipSync(Object.fromEntries(fixture.entries.map(entry => [
        entry.path,
        entry.bytes ?? new TextEncoder().encode(entry.content ?? ''),
      ])))
      const entries = decodeCreatorAppPayloadZip(payloadArchive)
      const analysis = analyzeCreatorAppPayload(entries)
      expect(analysis).toEqual({ status: 'ready', candidate: fixture.expected })
      if (analysis.status !== 'ready') throw new Error(`Fixture ${fixture.id} was not ready`)
      const bundle = createCanonicalCreatorAppBundle({
        entries,
        appId: `fixture-${fixture.id}`,
        version: '1.0.0',
        name: fixture.id,
        entry: analysis.candidate,
      })
      expect(validateProductionCreatorAppBundle(bundle.archive, bundle.manifest)).toMatchObject({
        appId: `fixture-${fixture.id}`,
        runtime: fixture.expected.runtime,
        entry: [fixture.expected.path],
        permissions: [],
      })
      if (fixture.id === 'next-standalone') {
        const paths = new Set(bundle.entries.map(entry => entry.path))
        expect(paths.has('server/node_modules/next/package.json')).toBeTrue()
        expect(paths.has('server/public/favicon.ico')).toBeTrue()
        expect(paths.has('server/.next/static/chunks/app.js')).toBeTrue()
      }
    }
  })

  it('exports one canonical entry and 200 MiB archive boundary for every consumer', () => {
    expect(CREATOR_APP_CANONICAL_ENTRIES).toEqual({
      static: 'index.html',
      python: 'server/main.py',
      js: 'server/index.js',
    })
    expect(CREATOR_APP_PAYLOAD_LIMITS.archiveBytes).toBe(200 * 1024 * 1024)
  })

  it('rewrites a legacy bundle identity and permissions before calculating final metadata', () => {
    const binaryAsset = new Uint8Array([0, 255, 1, 2])
    const result = createCanonicalCreatorAppBundle({
      entries: [
        { path: 'index.html', content: '<!doctype html>' },
        { path: 'assets/logo.bin', bytes: binaryAsset },
        {
          path: 'polo-app.json',
          content: JSON.stringify({
            schemaVersion: 1,
            appId: 'creator-controlled-id',
            version: '99.0.0',
            runtime: 'static',
            entry: ['index.html'],
            permissions: [],
          }),
        },
      ],
      appId: 'server-app-id',
      version: '1.0.0',
      name: 'Rewritten App',
      entry: { runtime: 'static', path: 'index.html' },
    })
    const finalManifest = JSON.parse(result.entries.find(entry => entry.path === 'polo-app.json')!.content)
    expect(finalManifest).toMatchObject({
      appId: 'server-app-id',
      version: '1.0.0',
      permissions: [],
    })
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(unzipSync(result.archive)['assets/logo.bin']).toEqual(binaryAsset)
    expect(validateProductionCreatorAppBundle(result.archive, result.manifest)).toMatchObject({
      appId: 'server-app-id', permissions: [],
    })
  })

  it('uses the installer Manifest contract for the final production ZIP', () => {
    const base = {
      schemaVersion: 1,
      appId: 'server-app-id',
      version: '1.0.0',
      runtime: 'static',
      entry: ['index.html'],
      healthcheck: '/',
      webPath: '/',
      permissions: [],
    }
    for (const manifest of [
      { ...base, appId: '' },
      { ...base, entry: ['../index.html'] },
      { ...base, healthcheck: 'relative' },
      { ...base, permissions: ['host.read'] },
    ]) {
      const archive = zipSync({
        'index.html': new TextEncoder().encode('<!doctype html>'),
        'polo-app.json': new TextEncoder().encode(JSON.stringify(manifest)),
      })
      expect(() => validateProductionCreatorAppBundle(archive)).toThrow(
        'production Manifest contract',
      )
    }
  })

  it('decodes actual ZIP bytes and rejects traversal before analysis', () => {
    const payload = zipSync({
      'index.html': new TextEncoder().encode('<!doctype html>'),
      'assets/raw.bin': new Uint8Array([0, 255, 1]),
    })
    expect(decodeCreatorAppPayloadZip(payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'assets/raw.bin', bytes: new Uint8Array([0, 255, 1]) }),
    ]))
    expect(() => decodeCreatorAppPayloadZip(zipSync({ '../escape': new Uint8Array([1]) }))).toThrow('unsafe archive')
    expect(() => decodeCreatorAppPayloadZip(zipSync({ 'bomb.txt': new TextEncoder().encode('x'.repeat(1024 * 1024)) }, { level: 9 }))).toThrow('unsafe archive')
  })

  it('safely strips an explicit enclosing directory and preserves empty directories', () => {
    const archive = zipSync({
      'myapp/': new Uint8Array(),
      'myapp/empty/': new Uint8Array(),
      'myapp/index.html': new TextEncoder().encode('<!doctype html>'),
    })
    const entries = decodeCreatorAppPayloadZip(archive)
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'index.html', type: 'file' }),
    ]))
    expect(analyzeCreatorAppPayload(entries)).toMatchObject({ status: 'ready', candidate: { path: 'index.html' } })
  })

  it('refuses a caller-selected traversal, missing, or runtime-mismatched entry', () => {
    const input = {
      entries: [
        { path: 'server/main.py', content: dynamicRuntimeEvidence },
        { path: 'pyproject.toml', content: '[project]\nname = "app"' },
        { path: 'uv.lock', content: '# lock marker' },
      ],
      appId: 'server-app-id',
      version: '1.0.0',
      name: 'Safe App',
    }
    for (const entry of [
      { runtime: 'python' as const, path: '../server/main.py' },
      { runtime: 'python' as const, path: 'missing.py' },
      { runtime: 'js' as const, path: 'server/main.py' },
    ]) {
      expect(() => createCanonicalCreatorAppBundle({ ...input, entry })).toThrow(
        'not a safe analyzed candidate',
      )
    }
  })

  it('makes the Console mode and source organization an explicit, authorization-safe query contract', () => {
    expect(buildCreatorAppPublishingUrl('https://admin.example.test/base', {
      organizationId: 'organization-one',
      mode: 'upload',
    })).toBe('https://admin.example.test/organization-apps/publish?organizationId=organization-one&mode=upload')
    expect(resolveCreatorAppPublishingOrganization({
      requestedOrganizationId: 'organization-one',
      availableOrganizationIds: ['organization-one', 'organization-two'],
      fallbackOrganizationId: 'organization-two',
    })).toEqual({ organizationId: 'organization-one', source: 'requested' })
    expect(resolveCreatorAppPublishingOrganization({
      requestedOrganizationId: 'removed-organization',
      availableOrganizationIds: ['organization-two'],
      fallbackOrganizationId: 'organization-two',
    })).toEqual({ organizationId: 'organization-two', source: 'fallback' })
  })
})
