import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import {
  GENUI_APP_PUBLISH_ENTRIES,
  GENUI_CATALOG_READ_ONLY_NOTICE,
  GENUI_PUBLISH_SDK_BRIDGE_NOTICE,
  buildGenUiAppArtifactZip,
  buildGenUiPublishNotice,
  collectGenUiAppPublishFiles,
  evaluateGenUiAppPublishPolicy,
  type GenUiAppPublishFile,
} from '../app-publish'

function makeAppDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'genui-publish-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8')
  }
  return dir
}

describe('collectGenUiAppPublishFiles', () => {
  test('collects the payload entries and skips session-local version.json', () => {
    const dir = makeAppDir({
      'index.html': '<html></html>',
      'app.js': 'console.log(1)',
      'app.css': 'body{}',
      'version.json': '{"version":2}',
    })
    try {
      const result = collectGenUiAppPublishFiles(dir)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.files.map(f => f.path)).toEqual(['app.css', 'app.js', 'index.html'])
        expect(new TextDecoder().decode(result.files.find(f => f.path === 'index.html')!.bytes)).toBe('<html></html>')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fails closed on a missing index.html', () => {
    const dir = makeAppDir({ 'app.js': 'x' })
    try {
      const result = collectGenUiAppPublishFiles(dir)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('missing index.html')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('never sweeps unexpected files into a distributed artifact', () => {
    const dir = makeAppDir({ 'index.html': '<html></html>', 'notes.txt': 'private' })
    try {
      const result = collectGenUiAppPublishFiles(dir)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('notes.txt')
        expect(result.error).toContain('inline other assets into index.html')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fails closed when an entry is not a regular file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genui-publish-'))
    mkdirSync(join(dir, 'index.html'))
    try {
      const result = collectGenUiAppPublishFiles(dir)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('not a regular file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fails closed on an unreadable app directory', () => {
    const result = collectGenUiAppPublishFiles(join(tmpdir(), 'genui-publish-does-not-exist'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('not readable')
  })
})

describe('buildGenUiAppArtifactZip', () => {
  test('zips at the root layout — no enclosing wrapper directory', () => {
    const files: GenUiAppPublishFile[] = [
      { path: 'index.html', bytes: new TextEncoder().encode('<html></html>') },
      { path: 'app.js', bytes: new TextEncoder().encode('x') },
    ]
    const archive = unzipSync(buildGenUiAppArtifactZip(files))
    expect(Object.keys(archive).sort()).toEqual(['app.js', 'index.html'])
    expect(new TextDecoder().decode(archive['index.html']!)).toBe('<html></html>')
  })

  test('is deterministic for the same input', () => {
    const files: GenUiAppPublishFile[] = [{ path: 'index.html', bytes: new TextEncoder().encode('<html></html>') }]
    expect(Buffer.from(buildGenUiAppArtifactZip(files)).equals(Buffer.from(buildGenUiAppArtifactZip(files)))).toBe(true)
  })
})

describe('evaluateGenUiAppPublishPolicy', () => {
  const file = (name: string, size: number): GenUiAppPublishFile => ({
    path: name,
    bytes: new Uint8Array(size),
  })

  test('passes a conforming bundle', () => {
    expect(evaluateGenUiAppPublishPolicy(
      [file('index.html', 100)],
      { enabled: true, maxBundleBytes: 1000, maxFileCount: 1 },
    )).toEqual({ ok: true })
  })

  test('refuses everything when the policy disables publishing', () => {
    const verdict = evaluateGenUiAppPublishPolicy(
      [file('index.html', 1)],
      { enabled: false, maxBundleBytes: 1000, maxFileCount: 1 },
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toContain('disabled by the web_app artifact policy')
  })

  test('enforces the byte and file-count caps', () => {
    const overBytes = evaluateGenUiAppPublishPolicy(
      [file('index.html', 101)],
      { enabled: true, maxBundleBytes: 100, maxFileCount: 1 },
    )
    expect(overBytes.ok).toBe(false)
    if (!overBytes.ok) expect(overBytes.error).toContain('policy limit')

    const overCount = evaluateGenUiAppPublishPolicy(
      [file('index.html', 10), file('app.js', 10)],
      { enabled: true, maxBundleBytes: 1000, maxFileCount: 1 },
    )
    expect(overCount.ok).toBe(false)
    if (!overCount.ok) expect(overCount.error).toContain('file limit')
  })
})

describe('publish policy copy (expectation management)', () => {
  test('SDK notice pins bridge protocol 1 and the incompatible host line', () => {
    expect(GENUI_PUBLISH_SDK_BRIDGE_NOTICE).toContain('@polo-ai/sdk')
    expect(GENUI_PUBLISH_SDK_BRIDGE_NOTICE).toContain('bridge protocol 1')
    expect(GENUI_PUBLISH_SDK_BRIDGE_NOTICE).toContain('0.16.3')
    expect(GENUI_PUBLISH_SDK_BRIDGE_NOTICE).toContain('NOT compatible')
  })

  test('catalog notice marks third-party components read-only', () => {
    expect(GENUI_CATALOG_READ_ONLY_NOTICE).toContain('read-only')
    expect(GENUI_CATALOG_READ_ONLY_NOTICE).toContain('poloai:// v2')
  })

  test('combined notice carries both texts', () => {
    const notice = buildGenUiPublishNotice()
    expect(notice).toContain('bridge protocol 1')
    expect(notice).toContain('read-only')
  })

  test('publish entries stay in sync with the collection allowlist', () => {
    expect(GENUI_APP_PUBLISH_ENTRIES).toEqual(['index.html', 'app.js', 'app.css'])
  })
})
