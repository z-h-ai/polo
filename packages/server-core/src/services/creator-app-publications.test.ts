import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreatorAppPublicationService } from './creator-app-publications'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('CreatorAppPublicationService', () => {
  it('persists an immutable validated Bundle and append-only audit without retaining raw upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-creator-app-'))
    roots.push(root)
    const service = new CreatorAppPublicationService(root)
    const result = await service.publishUpload({
      organizationId: 'org-one', name: 'Static', entries: [{ path: 'outer/index.html', content: '<!doctype html>' }],
    })
    if (result.status === 'needs_entry_selection') throw new Error('expected static publication')
    expect(result).toMatchObject({ status: 'published', version: '1.0.0', checksum: expect.any(String) })
    const bundle = await readFile(join(root, `${result.appId}.zip`))
    expect(bundle.byteLength).toBeGreaterThan(0)
    expect(await readFile(join(root, 'audit.jsonl'), 'utf8')).toContain(result.appId)
  })

  it('returns deterministic candidates and only accepts a returned candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-creator-app-'))
    roots.push(root)
    const service = new CreatorAppPublicationService(root)
    const entries = [
      { path: 'app.py', content: "@app.get('/health')" },
      { path: 'server.py', content: "@app.get('/health')" },
      { path: 'pyproject.toml', content: '[project]\nname = "app"' },
      { path: 'uv.lock', content: 'version = "1"' },
    ]
    await expect(service.publishUpload({ organizationId: 'org-one', name: 'Python', entries })).resolves.toMatchObject({
      status: 'needs_entry_selection', candidates: [{ path: 'app.py' }, { path: 'server.py' }],
    })
    await expect(service.publishUpload({ organizationId: 'org-one', name: 'Python', entries, entry: { runtime: 'python', path: '../nope.py' } })).rejects.toThrow('safe analyzed candidate')
  })
})
