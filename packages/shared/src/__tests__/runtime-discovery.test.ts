import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  areMajorVersionsCompatible,
  readElectronRuntimeDiscovery,
  removeElectronRuntimeDiscovery,
  writeElectronRuntimeDiscovery,
} from '../runtime-discovery'

const roots: string[] = []

function tempPath(): string {
  const root = join(tmpdir(), `polo-runtime-test-${crypto.randomUUID()}`)
  roots.push(root)
  return join(root, 'runtime', 'electron.json')
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Electron runtime discovery', () => {
  it('writes an atomic private file and reads it back', () => {
    const path = tempPath()
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: 'ws://127.0.0.1:53124',
      token: '0123456789abcdef0123456789abcdef',
      version: '0.10.0',
    }, { path })

    const result = readElectronRuntimeDiscovery({ path, expectedVersion: '0.10.3' })
    expect(result.status).toBe('available')
    if (result.status === 'available') {
      expect(result.record.pid).toBe(process.pid)
      expect(result.record.token).toBe('0123456789abcdef0123456789abcdef')
    }
  })

  it('rejects unsafe permissions', () => {
    if (process.platform === 'win32') return
    const path = tempPath()
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: 'ws://localhost:53124',
      token: '0123456789abcdef',
      version: '0.10.0',
    }, { path })
    chmodSync(path, 0o644)

    expect(readElectronRuntimeDiscovery({ path }).status).toBe('invalid')
  })

  it('rejects unsafe runtime directory permissions', () => {
    if (process.platform === 'win32') return
    const path = tempPath()
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: 'ws://localhost:53124',
      token: '0123456789abcdef',
      version: '0.10.0',
    }, { path })
    chmodSync(dirname(path), 0o755)

    const result = readElectronRuntimeDiscovery({ path })
    expect(result.status).toBe('invalid')
    expect(result.status === 'invalid' ? result.reason : '').toContain('0700')
  })

  it('cleans a stale runtime file', () => {
    const path = tempPath()
    writeElectronRuntimeDiscovery({
      pid: 2_147_483_647,
      url: 'ws://127.0.0.1:53124',
      token: '0123456789abcdef',
      version: '0.10.0',
    }, { path })

    expect(readElectronRuntimeDiscovery({ path, cleanupStale: true }).status).toBe('stale')
    expect(readElectronRuntimeDiscovery({ path }).status).toBe('missing')
  })

  it('rejects non-loopback URLs and malformed data', () => {
    const path = tempPath()
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      url: 'ws://192.168.1.5:9100',
      token: '0123456789abcdef',
      version: '0.10.0',
      startedAt: new Date().toISOString(),
    }), { mode: 0o600 })

    expect(readElectronRuntimeDiscovery({ path }).status).toBe('invalid')
  })

  it('enforces major-version compatibility', () => {
    expect(areMajorVersionsCompatible('0.10.0', '0.11.0')).toBe(true)
    expect(areMajorVersionsCompatible('1.0.0', '2.0.0')).toBe(false)

    const path = tempPath()
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: 'ws://127.0.0.1:53124',
      token: '0123456789abcdef',
      version: '1.2.3',
    }, { path })
    expect(readElectronRuntimeDiscovery({ path, expectedVersion: '2.0.0' }).status).toBe('incompatible')
  })

  it('does not remove a newer process record', () => {
    const path = tempPath()
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: 'ws://127.0.0.1:53124',
      token: '0123456789abcdef',
      version: '0.10.0',
    }, { path })

    expect(removeElectronRuntimeDiscovery({ path, expectedPid: process.pid + 1 })).toBe(false)
    expect(removeElectronRuntimeDiscovery({ path, expectedPid: process.pid })).toBe(true)
  })
})
