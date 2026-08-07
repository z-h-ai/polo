import { describe, expect, it } from 'bun:test'
import {
  analyzeCreatorAppPayload,
  buildCreatorAppPublishingUrl,
  createCanonicalCreatorAppBundle,
  createPlatformOwnedManifest,
  resolveCreatorAppPublishingOrganization,
} from '../creator-app-publishing.ts'

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
      { path: 'main.py', content: 'raise RuntimeError()' },
      { path: 'requirements.txt', content: 'fastapi==1.0' },
    ])).toEqual({
      status: 'ready',
      candidate: { runtime: 'python', path: 'main.py' },
    })
    expect(analyzeCreatorAppPayload([
      { path: '.next/standalone/server.js', content: 'process.exit(1)' },
      { path: 'package-lock.json', content: '{}' },
    ])).toEqual({
      status: 'ready',
      candidate: { runtime: 'js', path: '.next/standalone/server.js' },
    })
  })

  it('asks only for an entry when more than one runnable service is found', () => {
    expect(analyzeCreatorAppPayload([
      { path: 'app.py' },
      { path: 'server.py' },
      { path: 'requirements.txt' },
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
    expect(analyzeCreatorAppPayload([{ path: 'src/index.ts' }])).toMatchObject({
      status: 'invalid',
      code: 'missing_runnable_payload',
      message: expect.stringContaining('POL-65'),
    })
  })

  it('rewrites a legacy bundle identity and permissions before calculating final metadata', () => {
    const result = createCanonicalCreatorAppBundle({
      entries: [
        { path: 'index.html', content: '<!doctype html>' },
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
