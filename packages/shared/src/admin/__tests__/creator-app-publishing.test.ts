import { describe, expect, it } from 'bun:test'
import {
  analyzeCreatorAppPayload,
  buildCreatorAppPublishingUrl,
  createCanonicalCreatorAppBundle,
  createPlatformOwnedManifest,
  decodeCreatorAppPayloadZip,
  resolveCreatorAppPublishingOrganization,
  validateProductionCreatorAppBundle,
} from '../creator-app-publishing.ts'
import { unzipSync, zipSync } from 'fflate'

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

  it('recognizes locked Python and JS service payloads without executing them', () => {
    expect(analyzeCreatorAppPayload([
      { path: 'main.py', content: "@app.get('/health')\ndef health(): pass" },
      { path: 'requirements.txt', content: 'fastapi==1.0' },
    ])).toEqual({
      status: 'ready',
      candidate: { runtime: 'python', path: 'main.py' },
    })
    expect(analyzeCreatorAppPayload([
      { path: '.next/standalone/server.js', content: "server.get('/health', () => {})" },
      { path: 'package-lock.json', content: '{"lockfileVersion": 3}' },
    ])).toEqual({
      status: 'ready',
      candidate: { runtime: 'js', path: '.next/standalone/server.js' },
    })
  })

  it('asks only for an entry when more than one runnable service is found', () => {
    expect(analyzeCreatorAppPayload([
      { path: 'app.py', content: "@app.get('/health')" },
      { path: 'server.py', content: "@app.get('/health')" },
      { path: 'requirements.txt', content: 'fastapi==1.0' },
    ])).toEqual({
      status: 'needs_entry_selection',
      candidates: [
        { runtime: 'python', path: 'app.py' },
        { runtime: 'python', path: 'server.py' },
      ],
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

  it('does not accept an empty dependency lock or a service without a health endpoint', () => {
    expect(analyzeCreatorAppPayload([
      { path: 'main.py', content: "@app.get('/health')" },
      { path: 'requirements.txt', content: '' },
    ])).toMatchObject({ status: 'invalid', code: 'missing_runnable_payload' })
    expect(analyzeCreatorAppPayload([
      { path: 'server.js', content: "server.get('/health', () => {})" },
      { path: 'package-lock.json', content: '{}' },
    ])).toMatchObject({ status: 'invalid', code: 'missing_runnable_payload' })
    expect(analyzeCreatorAppPayload([
      { path: 'server.js', content: 'server.listen(3000)' },
      { path: 'package-lock.json', content: '{}' },
    ])).toMatchObject({ status: 'invalid', code: 'missing_runnable_payload' })
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
            permissions: ['shell'],
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

  it('refuses a caller-selected traversal, missing, or runtime-mismatched entry', () => {
    const input = {
      entries: [
        { path: 'main.py', content: "@app.get('/health')" },
        { path: 'requirements.txt', content: 'fastapi==1.0' },
      ],
      appId: 'server-app-id',
      version: '1.0.0',
      name: 'Safe App',
    }
    for (const entry of [
      { runtime: 'python' as const, path: '../main.py' },
      { runtime: 'python' as const, path: 'missing.py' },
      { runtime: 'js' as const, path: 'main.py' },
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
