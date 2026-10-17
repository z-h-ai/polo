import { expect, test } from 'bun:test'
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeCreatorAppPayload, createCanonicalCreatorAppBundle, decodeCreatorAppPayloadZip } from '../../../../shared/src/admin/creator-app-publishing'

test('copied example builds a Creator-uploadable payload without reserving an app identity', async () => {
  const example = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const root = resolve(example, '../../../..')
  const project = await mkdtemp(resolve(tmpdir(), 'polo-quote-payload-'))
  try {
    await cp(example, project, { recursive: true, filter: source => !['dist', 'node_modules', 'polo-payload.zip'].includes(source.split('/').at(-1)!) })
    await symlink(resolve(root, 'node_modules'), resolve(project, 'node_modules'), 'dir')
    const env = { ...process.env }
    delete env.POLO_APP_ID
    delete env.POLO_APP_VERSION
    for (const script of ['build.mjs', 'package.mjs']) {
      const child = Bun.spawn([process.execPath, resolve(project, 'scripts', script)], { cwd: project, env, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect({ code, error: code === 0 ? '' : out + err }).toEqual({ code: 0, error: '' })
    }
    const entries = decodeCreatorAppPayloadZip(new Uint8Array(await readFile(resolve(project, 'polo-payload.zip'))))
    expect(entries.map(entry => entry.path).sort()).toEqual(['app.css', 'app.js', 'index.html'])
    const analysis = analyzeCreatorAppPayload(entries)
    expect(analysis).toEqual({ status: 'ready', candidate: { runtime: 'static', path: 'index.html' } })
    if (analysis.status !== 'ready') throw new Error('Creator ingress must detect the runnable payload')
    const bundle = createCanonicalCreatorAppBundle({ entries, appId: 'platform-assigned-quote', version: '1.0.0', name: 'Quote', entry: analysis.candidate })
    expect(bundle.manifest.appId).toBe('platform-assigned-quote')
    expect(bundle.manifest.entry).toEqual(['index.html'])
    const finalEntries = decodeCreatorAppPayloadZip(bundle.archive)
    for (const entry of entries) {
      expect(finalEntries.find(item => item.path === entry.path)?.bytes).toEqual(entry.bytes)
    }
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}, 30_000)
