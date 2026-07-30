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

  it('fails closed when Windows cannot prove that the PID has the current SID', () => {
    const path = tempPath()
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: 'ws://127.0.0.1:53124',
      token: '0123456789abcdef',
      version: '0.10.0',
    }, { path })

    const checkedProcesses: Array<{ pid: number; startedAt: string }> = []
    const result = readElectronRuntimeDiscovery({
      path,
      platform: 'win32',
      windowsProcessOwner(pid, startedAt) {
        checkedProcesses.push({ pid, startedAt })
        return false
      },
    })

    expect(checkedProcesses).toHaveLength(1)
    expect(checkedProcesses[0]?.pid).toBe(process.pid)
    expect(Date.parse(checkedProcesses[0]?.startedAt ?? '')).not.toBeNaN()
    expect(result.status).toBe('stale')
    expect(result.status === 'stale' ? result.reason : '').toContain('another user')
  })

  it('rejects a live same-user PID whose creation time is newer than the runtime record', () => {
    const path = tempPath()
    const recordedAt = '2026-07-29T12:00:00.000Z'
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: 'ws://127.0.0.1:53124',
      token: '0123456789abcdef',
      version: '0.10.0',
      startedAt: recordedAt,
    }, { path })

    const result = readElectronRuntimeDiscovery({
      path,
      platform: 'win32',
      windowsProcessOwner(pid, startedAt) {
        expect(pid).toBe(process.pid)
        expect(startedAt).toBe(recordedAt)
        // Simulate a process with the current SID whose CreationDate is newer
        // than the runtime file, which means the PID has been reused.
        return false
      },
    })

    expect(result.status).toBe('stale')
  })

  it('does not delete a replacement runtime record during stale cleanup', () => {
    const path = tempPath()
    const stalePid = process.pid + 10_000
    writeElectronRuntimeDiscovery({
      pid: stalePid,
      url: 'ws://127.0.0.1:53124',
      token: '0123456789abcdef',
      version: '0.10.0',
    }, { path })

    const result = readElectronRuntimeDiscovery({
      path,
      platform: 'win32',
      cleanupStale: true,
      windowsProcessOwner() {
        // Simulate Electron restarting and atomically replacing the discovery
        // file after the stale record was read but before cleanup.
        writeElectronRuntimeDiscovery({
          pid: process.pid,
          url: 'ws://127.0.0.1:53125',
          token: 'fedcba9876543210',
          version: '0.10.0',
        }, { path })
        return false
      },
    })

    expect(result.status).toBe('stale')
    const replacement = readElectronRuntimeDiscovery({ path })
    expect(replacement.status).toBe('available')
    if (replacement.status === 'available') {
      expect(replacement.record.pid).toBe(process.pid)
      expect(replacement.record.url).toBe('ws://127.0.0.1:53125')
    }
  })

  it('verifies the current process through Windows SID lookup on Windows', () => {
    if (process.platform !== 'win32') return
    const path = tempPath()
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: 'ws://127.0.0.1:53124',
      token: '0123456789abcdef',
      version: '0.10.0',
    }, { path })

    expect(readElectronRuntimeDiscovery({ path }).status).toBe('available')
  })

  it('rejects a reused current-user PID through Windows creation-time lookup', () => {
    if (process.platform !== 'win32') return
    const path = tempPath()
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: 'ws://127.0.0.1:53124',
      token: '0123456789abcdef',
      version: '0.10.0',
      // The current process cannot have existed at this timestamp. If only
      // the SID were checked this would be incorrectly accepted.
      startedAt: '2000-01-01T00:00:00.000Z',
    }, { path })

    expect(readElectronRuntimeDiscovery({ path }).status).toBe('stale')
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
