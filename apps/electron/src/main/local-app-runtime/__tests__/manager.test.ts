import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type ChildProcess, type spawn as spawnProcess } from 'child_process'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { watch } from 'fs'
import { createServer, type Server } from 'http'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Writable } from 'stream'
import { deflateRawSync } from 'zlib'
import * as tar from 'tar'
import { fetch as undiciFetch } from 'undici'
import {
  LOCAL_APP_INSTALL_OPERATION_TIMEOUT_MS,
  LOCAL_APP_INSTALL_RPC_TIMEOUT_MS,
} from '@polo-ai/shared/protocol'
import type {
  LocalAppArchitecture,
  LocalAppInstallRequest,
  LocalAppPlatform,
  LocalAppRuntimeStatus,
  PoloAppManifest,
} from '@polo-ai/shared/protocol'
import {
  LocalAppRuntimeManager,
  type LocalAppRuntimeManagerOptions,
} from '../manager'
import type {
  WindowsJobObjectOwner,
  WindowsProcessTreeOwner,
} from '../process-tree'
import { LocalAppRuntimeError } from '../runtime-error'
import { extractBundleArchive } from '../archive'
import { validatePoloAppManifest } from '../manifest'

const platform = process.platform as LocalAppPlatform
const architecture = process.arch as LocalAppArchitecture
const stableFetch = undiciFetch as unknown as typeof globalThis.fetch

let testRoot = ''
let manager: LocalAppRuntimeManager | null = null
let downloadServer: Server | null = null

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'polo-local-app-test-'))
})

afterEach(async () => {
  await manager?.shutdown()
  manager = null
  if (downloadServer) {
    await new Promise<void>(resolveClose => downloadServer!.close(() => resolveClose()))
    downloadServer = null
  }
  await rm(testRoot, { recursive: true, force: true })
})

async function writeBundle(
  appId: string,
  version: string,
  manifestOverrides: Partial<PoloAppManifest> = {},
  files: Record<string, string> = {},
): Promise<string> {
  const bundleDir = join(testRoot, `source-${appId}-${version}`)
  await mkdir(bundleDir, { recursive: true })
  const manifest: PoloAppManifest = {
    schemaVersion: 1,
    appId,
    version,
    runtime: 'static',
    entry: ['dist'],
    healthcheck: '/health',
    webPath: '/',
    permissions: [],
    ...manifestOverrides,
  }
  await writeFile(join(bundleDir, 'polo-app.json'), JSON.stringify(manifest), 'utf8')
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = join(bundleDir, relativePath)
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, content, 'utf8')
  }
  return bundleDir
}

async function archiveBundle(bundleDir: string, label: string): Promise<Buffer> {
  const archivePath = join(testRoot, `${label}.tar.gz`)
  await tar.c({ cwd: bundleDir, file: archivePath, gzip: true }, ['.'])
  return readFile(archivePath)
}

async function serveArchive(
  archive: Buffer,
  options: { chunkDelayMs?: number; onRequest?: () => void } = {},
): Promise<string> {
  downloadServer = createServer((_, response) => {
    options.onRequest?.()
    response.statusCode = 200
    response.setHeader('content-length', String(archive.length))
    if (!options.chunkDelayMs) {
      response.end(archive)
      return
    }
    let offset = 0
    const writeChunk = () => {
      if (offset >= archive.length) {
        response.end()
        return
      }
      const next = archive.subarray(offset, Math.min(archive.length, offset + 64))
      offset += next.length
      response.write(next)
      setTimeout(writeChunk, options.chunkDelayMs)
    }
    writeChunk()
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    downloadServer!.once('error', rejectListen)
    downloadServer!.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = downloadServer.address()
  if (!address || typeof address === 'string') throw new Error('download server has no port')
  return `http://127.0.0.1:${address.port}/bundle`
}

function requestFor(
  appId: string,
  version: string,
  url: string,
  archive: Buffer,
): LocalAppInstallRequest {
  return {
    appId,
    version,
    downloadUrl: url,
    checksum: createHash('sha256').update(archive).digest('hex'),
    sizeBytes: archive.length,
    platform,
    arch: architecture,
  }
}

function makeManager(options: Pick<
  LocalAppRuntimeManagerOptions,
  | 'uvPath'
  | 'bunPath'
  | 'baseEnvironment'
  | 'portAllocator'
  | 'onInstallProgress'
  | 'onManagedProcessStarted'
> = {}): LocalAppRuntimeManager {
  manager = new LocalAppRuntimeManager({
    rootDir: join(testRoot, 'runtime'),
    platform,
    arch: architecture,
    fetch: stableFetch,
    ...options,
  })
  return manager
}

interface FakeChildProcess extends ChildProcess {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

function makeFakeChild(
  pid: number,
  stdin: NodeJS.WritableStream | null = new PassThrough(),
): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess
  Object.assign(child, {
    pid,
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => true,
  })
  return child
}

function markFakeChildExited(child: FakeChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) return
  child.exitCode = 0
  child.emit('exit', 0, null)
}

function makeWindowsTestSpawner(
  gate: FakeChildProcess,
  onTaskkill: () => void = () => {},
): typeof spawnProcess {
  return ((command: string) => {
    if (command !== 'taskkill') return gate
    const killer = makeFakeChild(gate.pid + 10_000, null)
    queueMicrotask(() => {
      onTaskkill()
      markFakeChildExited(gate)
      markFakeChildExited(killer)
    })
    return killer
  }) as typeof spawnProcess
}

function makeSnapshotOwner(): WindowsProcessTreeOwner {
  return {
    terminate: async () => {},
    dispose: () => {},
  } as unknown as WindowsProcessTreeOwner
}

type WindowsGateInternals = {
  spawnManagedCommand(
    appId: string,
    kind: 'dependency-preparation' | 'runtime',
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<unknown>
  managedProcesses: Map<string, unknown>
}

function makeWindowsGateManager(options: {
  gate: FakeChildProcess
  owner: WindowsJobObjectOwner
  onTaskkill?: () => void
}): { runtime: LocalAppRuntimeManager; internals: WindowsGateInternals } {
  const runtime = new LocalAppRuntimeManager({
    rootDir: join(testRoot, 'runtime'),
    platform: 'win32',
    arch: architecture,
    fetch: stableFetch,
    processSpawner: makeWindowsTestSpawner(options.gate, options.onTaskkill),
    windowsJobObjectOwnerFactory: async () => options.owner,
    windowsProcessTreeOwnerFactory: makeSnapshotOwner,
  })
  manager = runtime
  return {
    runtime,
    internals: runtime as unknown as WindowsGateInternals,
  }
}

function makeStoredZip(path: string, content: Buffer): Buffer {
  const name = Buffer.from(path)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(0, 14)
  local.writeUInt32LE(content.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(0, 16)
  central.writeUInt32LE(content.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38)
  central.writeUInt32LE(0, 42)

  const centralOffset = local.length + name.length + content.length
  const centralSize = central.length + name.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, name, content, central, name, eocd])
}

function makeDeflatedZip(path: string, content: Buffer): Buffer {
  const name = Buffer.from(path)
  const compressed = deflateRawSync(content)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38)

  const centralOffset = local.length + name.length + compressed.length
  const centralSize = central.length + name.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, name, compressed, central, name, eocd])
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForJsonFile<T>(path: string): Promise<T> {
  return new Promise<T>((resolveFile, rejectFile) => {
    const directory = join(path, '..')
    const filename = path.slice(directory.length + 1)
    let settled = false
    let reading = false
    let readRequested = false
    const watcher = watch(directory)
    const settle = (error?: unknown, value?: T) => {
      if (settled) return
      settled = true
      watcher.close()
      if (error) rejectFile(error)
      else resolveFile(value!)
    }
    const read = async () => {
      if (settled) return
      if (reading) {
        readRequested = true
        return
      }
      reading = true
      try {
        settle(undefined, JSON.parse(await readFile(path, 'utf8')) as T)
      } catch {
        // The initial probe may run before the producer writes the file.
      } finally {
        reading = false
        if (readRequested) {
          readRequested = false
          void read()
        }
      }
    }
    watcher.on('change', (_event, changed) => {
      if (changed === null || changed.toString() === filename) void read()
    })
    watcher.once('error', settle)
    void read()
  })
}

async function getFreeLocalPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no port')
  const port = address.port
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => {
      if (error) rejectClose(error)
      else resolveClose()
    })
  })
  return port
}

function ownedNodeServerSource(options: { listenDelayMs?: number; body?: string } = {}): string {
  const listenDelayMs = options.listenDelayMs ?? 0
  const body = JSON.stringify(options.body ?? 'owned')
  return `
    const http = require('http')
    const listen = () => {
      http.createServer((_request, response) => {
        response.setHeader('x-polo-app-health-token', process.env.POLO_APP_HEALTH_TOKEN)
        response.end(${body})
      }).listen(Number(process.env.PORT), '127.0.0.1')
    }
    ${listenDelayMs > 0 ? `setTimeout(listen, ${listenDelayMs})` : 'listen()'}
  `
}

async function launchHangingDependencyInstall(appId: string): Promise<{
  runtime: LocalAppRuntimeManager
  install: ReturnType<LocalAppRuntimeManager['install']>
  pids: { root: number; child: number }
}> {
  const fakeBunPath = join(testRoot, `fake-bun-${appId}`)
  await writeFile(fakeBunPath, `#!${process.execPath}
    const { mkdirSync, writeFileSync } = require('fs')
    const { join } = require('path')
    const { spawn } = require('child_process')
    const dataDir = process.env.POLO_APP_DATA_DIR
    mkdirSync(dataDir, { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    writeFileSync(join(dataDir, 'installer-pids.json'), JSON.stringify({
      root: process.pid,
      child: child.pid,
    }))
    setInterval(() => {}, 1000)
  `)
  await chmod(fakeBunPath, 0o755)
  const bundle = await writeBundle(
    appId,
    '1.0.0',
    {
      runtime: 'js',
      entry: ['server.js'],
    },
    {
      'server.js': 'setInterval(() => {}, 1000)',
      'package.json': `{"name":"${appId}","version":"1.0.0"}`,
      'bun.lock': 'test lock placeholder',
    },
  )
  const archive = await archiveBundle(bundle, appId)
  const url = await serveArchive(archive)
  const dataDir = join(testRoot, `runtime/apps/${appId}/data`)
  await mkdir(dataDir, { recursive: true })
  const pidFile = join(dataDir, 'installer-pids.json')
  const pidsWritten = waitForJsonFile<{ root: number; child: number }>(pidFile)
  let dependencyStarted!: () => void
  const dependencyStart = new Promise<void>(resolve => {
    dependencyStarted = resolve
  })
  const runtime = makeManager({
    bunPath: fakeBunPath,
    onManagedProcessStarted: (startedAppId, kind) => {
      if (startedAppId === appId && kind === 'dependency-preparation') {
        dependencyStarted()
      }
    },
  })
  const install = runtime.install(requestFor(appId, '1.0.0', url, archive))
  await dependencyStart
  const pids = await pidsWritten
  return { runtime, install, pids }
}

describe('LocalAppRuntimeManager', () => {
  it('keeps the install RPC deadline beyond the manager operation ceiling', () => {
    expect(LOCAL_APP_INSTALL_RPC_TIMEOUT_MS).toBeGreaterThan(
      LOCAL_APP_INSTALL_OPERATION_TIMEOUT_MS,
    )
  })

  it('accepts the full business app id contract independently of the runtime path id', async () => {
    for (const businessAppId of ['App.ID', '应用-甲', 'x'.repeat(512)]) {
      expect(validatePoloAppManifest({
        schemaVersion: 1,
        appId: businessAppId,
        version: '1.0.0',
        runtime: 'static',
        entry: ['dist'],
        healthcheck: '/health',
        webPath: '/',
        permissions: [],
      }, { platform, arch: architecture }).appId).toBe(businessAppId)
    }

    const businessAppId = '应用.App-ID'
    const runtimeAppId = `catalog-${'a'.repeat(64)}`
    const bundleDir = await writeBundle(
      'bundle-source',
      '1.0.0',
      { appId: businessAppId },
      { 'dist/index.html': 'business-id-ready' },
    )
    const archive = await archiveBundle(bundleDir, 'business-id')
    const url = await serveArchive(archive)
    const runtime = makeManager()
    const request = {
      ...requestFor(runtimeAppId, '1.0.0', url, archive),
      expectedManifestAppId: businessAppId,
    }

    await expect(runtime.install(request)).resolves.toMatchObject({
      appId: runtimeAppId,
      currentVersion: '1.0.0',
    })
  })

  it('installs, starts, stops, and idempotently restarts a static bundle', async () => {
    const bundleDir = await writeBundle(
      'demo.static',
      '1.0.0',
      { webPath: '/app' },
      {
        'dist/index.html': '<h1>static-ready</h1>',
        'dist/asset.txt': '0123456789',
      },
    )
    const archive = await archiveBundle(bundleDir, 'static')
    const url = await serveArchive(archive)
    const runtime = makeManager()
    const request = requestFor('demo.static', '1.0.0', url, archive)

    const firstInstall = await runtime.install(request)
    const secondInstall = await runtime.install(request)
    expect(firstInstall.currentVersion).toBe('1.0.0')
    expect(secondInstall.versions).toEqual(['1.0.0'])
    expect(await readdir(join(testRoot, 'runtime/apps/demo.static/versions'))).toEqual(['1.0.0'])
    const oversizedAsset = join(
      testRoot,
      'runtime/apps/demo.static/versions/1.0.0/dist/oversized.bin',
    )
    await writeFile(oversizedAsset, '')
    await truncate(oversizedAsset, 256 * 1024 * 1024 + 1)

    const started = await runtime.start('demo.static')
    expect(started.url).toContain('/app')
    expect(await (await stableFetch(started.url)).text()).toContain('static-ready')
    const staticHealth = await stableFetch(new URL('/health', started.url))
    expect(staticHealth.status).toBe(200)
    expect(staticHealth.headers.get('x-polo-app-health-token')).toBeTruthy()
    const assetUrl = new URL('/app/asset.txt', started.url)
    const partialAsset = await stableFetch(assetUrl, { headers: { range: 'bytes=2-5' } })
    expect(partialAsset.status).toBe(206)
    expect(partialAsset.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await partialAsset.text()).toBe('2345')
    const assetHead = await stableFetch(assetUrl, { method: 'HEAD' })
    expect(assetHead.headers.get('content-length')).toBe('10')
    expect(await assetHead.text()).toBe('')
    expect((await stableFetch(new URL('/app/oversized.bin', started.url))).status).toBe(413)
    expect((await runtime.getRuntimeStatus('demo.static')).status).toBe('running')

    await runtime.stop('demo.static')
    expect((await runtime.getRuntimeStatus('demo.static')).status).toBe('stopped')
    const restarted = await runtime.start('demo.static')
    expect(await (await stableFetch(restarted.url)).text()).toContain('static-ready')

    const logs = await runtime.getLogs('demo.static')
    expect(logs).toContain('Installed 1.0.0')
    expect(logs).toContain('Healthy at')
  })

  it('does not return a deferred failure log snapshot after restart recovers', async () => {
    const appId = 'demo.failure-recovery-logs'
    const bundleDir = await writeBundle(
      appId,
      '1.0.0',
      {},
      { 'dist/index.html': 'recovered' },
    )
    const archive = await archiveBundle(bundleDir, 'failure-recovery-logs')
    const url = await serveArchive(archive)
    let logsEntered!: () => void
    const entered = new Promise<void>(resolve => {
      logsEntered = resolve
    })
    let releaseLogs!: () => void
    const release = new Promise<void>(resolve => {
      releaseLogs = resolve
    })
    class DeferredLogManager extends LocalAppRuntimeManager {
      override async getLogs(): Promise<string> {
        logsEntered()
        await release
        return 'sensitive output written after recovery'
      }
    }
    const runtime = new DeferredLogManager({
      rootDir: join(testRoot, 'runtime'),
      platform,
      arch: architecture,
      fetch: stableFetch,
    })
    manager = runtime
    await runtime.install(requestFor(appId, '1.0.0', url, archive))
    const internals = runtime as unknown as {
      statuses: Map<string, LocalAppRuntimeStatus>
    }
    internals.statuses.set(appId, {
      appId,
      status: 'broken',
      currentVersion: '1.0.0',
      error: {
        code: 'START_FAILED',
        message: 'health check failed',
      },
    })

    const pendingLogs = runtime.getFailureRecoveryLogs(appId, { tail: 20 })
    await entered
    await expect(runtime.restart(appId)).resolves.toMatchObject({
      appId,
      version: '1.0.0',
    })
    expect((await runtime.getRuntimeStatus(appId)).status).toBe('running')

    releaseLogs()
    await expect(pendingLogs).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    })
  })

  it('serializes stop against an in-flight start and leaves no running process', async () => {
    const bundleDir = await writeBundle(
      'demo.start-stop',
      '1.0.0',
      {
        runtime: 'js',
        entry: ['server.js'],
        startTimeoutMs: 5_000,
      },
      {
        'server.js': `
          const http = require('http')
          const readyAt = Date.now() + 2_000
          http.createServer((request, response) => {
            const healthy = request.url !== '/health' || Date.now() >= readyAt
            response.statusCode = healthy ? 200 : 503
            response.setHeader('x-polo-app-health-token', process.env.POLO_APP_HEALTH_TOKEN)
            response.end(healthy ? 'ok' : 'starting')
          }).listen(Number(process.env.PORT), '127.0.0.1')
        `,
      },
    )
    const archive = await archiveBundle(bundleDir, 'start-stop')
    const url = await serveArchive(archive)
    const runtime = makeManager({ bunPath: process.execPath })
    await runtime.install(requestFor('demo.start-stop', '1.0.0', url, archive))

    const startResult = runtime.start('demo.start-stop').then(
      value => ({ value, error: null }),
      error => ({ value: null, error }),
    )
    let startingUrl: string | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await runtime.getRuntimeStatus('demo.start-stop')
      if (status.status === 'starting' && status.url) {
        startingUrl = status.url
        break
      }
      await Bun.sleep(10)
    }
    expect(startingUrl).toBeTruthy()

    const stopped = await runtime.stop('demo.start-stop')
    const startOutcome = await startResult
    expect(startOutcome.value).toBeNull()
    expect(startOutcome.error).toMatchObject({ code: 'START_FAILED' })
    expect(stopped.status).toBe('stopped')
    expect((await runtime.getRuntimeStatus('demo.start-stop')).status).toBe('stopped')
    await expect(stableFetch(startingUrl!)).rejects.toThrow()

    const secondStart = runtime.start('demo.start-stop').then(
      value => ({ value, error: null }),
      error => ({ value: null, error }),
    )
    let secondUrl: string | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await runtime.getRuntimeStatus('demo.start-stop')
      if (status.status === 'starting' && status.url) {
        secondUrl = status.url
        break
      }
      await Bun.sleep(10)
    }
    await runtime.uninstall('demo.start-stop')
    expect((await secondStart).error).toMatchObject({ code: 'START_FAILED' })
    expect((await runtime.getRuntimeStatus('demo.start-stop')).status).toBe('not_installed')
    await expect(stableFetch(secondUrl!)).rejects.toThrow()
  })

  it('serializes an update commit behind a slow start without losing either version', async () => {
    const v1Bundle = await writeBundle(
      'demo.concurrent-update',
      '1.0.0',
      {
        runtime: 'js',
        entry: ['server.js'],
        startTimeoutMs: 5_000,
      },
      {
        'server.js': `
          const http = require('http')
          const readyAt = Date.now() + 600
          http.createServer((request, response) => {
            response.statusCode = request.url === '/health' && Date.now() < readyAt ? 503 : 200
            response.setHeader('x-polo-app-health-token', process.env.POLO_APP_HEALTH_TOKEN)
            response.end('v1')
          }).listen(Number(process.env.PORT), '127.0.0.1')
        `,
      },
    )
    const v1Archive = await archiveBundle(v1Bundle, 'concurrent-v1')
    const v1Url = await serveArchive(v1Archive)
    const runtime = makeManager({ bunPath: process.execPath })
    await runtime.install(requestFor('demo.concurrent-update', '1.0.0', v1Url, v1Archive))
    await new Promise<void>(resolveClose => downloadServer!.close(() => resolveClose()))
    downloadServer = null

    const v2Bundle = await writeBundle(
      'demo.concurrent-update',
      '2.0.0',
      {},
      { 'dist/index.html': 'v2' },
    )
    const v2Archive = await archiveBundle(v2Bundle, 'concurrent-v2')
    const v2Url = await serveArchive(v2Archive)
    const start = runtime.start('demo.concurrent-update')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await runtime.getRuntimeStatus('demo.concurrent-update')).status === 'starting') break
      await Bun.sleep(10)
    }
    const install = runtime.install(
      requestFor('demo.concurrent-update', '2.0.0', v2Url, v2Archive),
    )

    const [started, installed] = await Promise.all([start, install])
    expect(started.version).toBe('1.0.0')
    expect(installed.currentVersion).toBe('2.0.0')
    expect(installed.versions).toEqual(['1.0.0', '2.0.0'])
    const status = await runtime.getRuntimeStatus('demo.concurrent-update')
    expect(status.status).toBe('running')
    expect(status.runningVersion).toBe('1.0.0')
    expect(status.currentVersion).toBe('2.0.0')
    expect((await readdir(join(
      testRoot,
      'runtime/apps/demo.concurrent-update/versions',
    ))).sort()).toEqual(['1.0.0', '2.0.0'])
  })

  it('publishes and persists update_available from catalog release metadata', async () => {
    const bundleDir = await writeBundle(
      'demo.available-update',
      '1.0.0',
      {},
      { 'dist/index.html': 'v1' },
    )
    const archive = await archiveBundle(bundleDir, 'available-update')
    const url = await serveArchive(archive)
    const runtime = makeManager()
    await runtime.install(requestFor('demo.available-update', '1.0.0', url, archive))

    const update = {
      version: '2.0.0',
      downloadUrl: 'https://downloads.example.test/demo.available-update-2.0.0.tar.gz',
      checksum: 'A'.repeat(64),
      sizeBytes: 42,
      platform,
      arch: architecture,
    } as const
    const published = await runtime.setAvailableRelease('demo.available-update', update)
    expect(published.status).toBe('update_available')
    expect(published.availableRelease?.checksum).toBe('a'.repeat(64))
    expect((await runtime.getInstalledApps())[0]).toMatchObject({
      status: 'update_available',
      availableRelease: {
        version: '2.0.0',
      },
    })

    const reloaded = new LocalAppRuntimeManager({
      rootDir: join(testRoot, 'runtime'),
      platform,
      arch: architecture,
      fetch: stableFetch,
    })
    expect((await reloaded.getRuntimeStatus('demo.available-update')).status)
      .toBe('update_available')
    await reloaded.shutdown()

    expect((await runtime.setAvailableRelease(
      'demo.available-update',
      { version: '1.0.0' },
    )).status).toBe('installed')
    expect((await runtime.setAvailableRelease('demo.available-update', null)).status)
      .toBe('installed')
  })

  it('does not reuse an active install for a conflicting release identity', async () => {
    const bundleDir = await writeBundle(
      'demo.active-identity',
      '1.0.0',
      {},
      { 'dist/index.html': 'x'.repeat(32_000) },
    )
    const archive = await archiveBundle(bundleDir, 'active-identity')
    const url = await serveArchive(archive, { chunkDelayMs: 25 })
    const runtime = makeManager()
    const request = requestFor('demo.active-identity', '1.0.0', url, archive)
    const first = runtime.install(request)

    expect(runtime.install({ ...request })).toBe(first)
    await expect(runtime.install({
      ...request,
      checksum: 'f'.repeat(64),
    })).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
    })

    expect(runtime.cancelInstall('demo.active-identity')).toBe(true)
    await expect(first).rejects.toMatchObject({ code: 'INSTALL_CANCELLED' })
  })

  it('waits for crash cleanup and starts a fresh process on immediate retry', async () => {
    const bundleDir = await writeBundle(
      'demo.crash-retry',
      '1.0.0',
      {
        runtime: 'js',
        entry: ['server.js'],
        startTimeoutMs: 3_000,
      },
      {
        'server.js': `
          const { existsSync, writeFileSync } = require('fs')
          const { join } = require('path')
          const { spawn } = require('child_process')
          const http = require('http')
          const marker = join(process.env.POLO_APP_DATA_DIR, 'crashed-once')
          const first = !existsSync(marker)
          if (first) {
            writeFileSync(marker, 'yes')
            spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
              stdio: 'ignore',
            })
          }
          http.createServer((_request, response) => {
            response.setHeader('x-polo-app-health-token', process.env.POLO_APP_HEALTH_TOKEN)
            response.end(first ? 'first' : 'retry')
          })
            .listen(Number(process.env.PORT), '127.0.0.1')
          if (first) setTimeout(() => process.exit(23), 500)
        `,
      },
    )
    const archive = await archiveBundle(bundleDir, 'crash-retry')
    const url = await serveArchive(archive)
    const runtime = makeManager({ bunPath: process.execPath })
    await runtime.install(requestFor('demo.crash-retry', '1.0.0', url, archive))

    const first = await runtime.start('demo.crash-retry')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await runtime.getRuntimeStatus('demo.crash-retry')).status === 'broken') break
      await Bun.sleep(10)
    }
    expect((await runtime.getRuntimeStatus('demo.crash-retry')).status).toBe('broken')

    const retried = await runtime.start('demo.crash-retry')
    expect(retried.port).not.toBe(first.port)
    expect(await (await stableFetch(retried.url)).text()).toBe('retry')
    expect((await runtime.getRuntimeStatus('demo.crash-retry')).status).toBe('running')
  }, 15_000)

  it('does not publish running when the process exits immediately after health', async () => {
    const bundleDir = await writeBundle(
      'demo.health-exit',
      '1.0.0',
      {
        runtime: 'js',
        entry: ['server.js'],
        startTimeoutMs: 2_000,
      },
      {
        'server.js': `
          const http = require('http')
          http.createServer((_request, response) => {
            response.setHeader('x-polo-app-health-token', process.env.POLO_APP_HEALTH_TOKEN)
            response.end('ok', () => process.exit(0))
          }).listen(Number(process.env.PORT), '127.0.0.1')
        `,
      },
    )
    const archive = await archiveBundle(bundleDir, 'health-exit')
    const url = await serveArchive(archive)
    const runtime = makeManager({ bunPath: process.execPath })
    await runtime.install(requestFor('demo.health-exit', '1.0.0', url, archive))

    await expect(runtime.start('demo.health-exit')).rejects.toMatchObject({
      code: 'PROCESS_CRASHED',
    })
    expect((await runtime.getRuntimeStatus('demo.health-exit')).status).toBe('broken')
  })

  it('rejects an unrelated healthy listener that claims the allocated port', async () => {
    const bundleDir = await writeBundle(
      'demo.foreign-listener',
      '1.0.0',
      {
        runtime: 'js',
        entry: ['server.js'],
        startTimeoutMs: 3_000,
      },
      {
        'server.js': ownedNodeServerSource({ listenDelayMs: 10_000 }),
      },
    )
    const archive = await archiveBundle(bundleDir, 'foreign-listener')
    const url = await serveArchive(archive)
    const runtime = makeManager({ bunPath: process.execPath })
    await runtime.install(requestFor('demo.foreign-listener', '1.0.0', url, archive))

    const start = runtime.start('demo.foreign-listener')
    let allocatedPort = 0
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await runtime.getRuntimeStatus('demo.foreign-listener')
      if (status.status === 'starting' && status.port) {
        allocatedPort = status.port
        break
      }
      await Bun.sleep(10)
    }
    expect(allocatedPort).toBeGreaterThan(0)

    const foreignServer = createServer((_request, response) => {
      response.statusCode = 200
      response.end('UNRELATED_LISTENER')
    })
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        foreignServer.once('error', rejectListen)
        foreignServer.listen(allocatedPort, '127.0.0.1', () => resolveListen())
      })
      await expect(start).rejects.toMatchObject({
        code: 'PORT_UNAVAILABLE',
        details: { port: allocatedPort },
      })
    } finally {
      await new Promise<void>(resolveClose => foreignServer.close(() => resolveClose()))
    }
    expect((await runtime.getRuntimeStatus('demo.foreign-listener')).status).toBe('stopped')
  })

  it('rejects a second App competing for the same local port', async () => {
    const fixedPort = await getFreeLocalPort()
    const runtime = makeManager({
      bunPath: process.execPath,
      portAllocator: async () => fixedPort,
    })
    for (const appId of ['demo.port-owner-a', 'demo.port-owner-b']) {
      const bundleDir = await writeBundle(
        appId,
        '1.0.0',
        {
          runtime: 'js',
          entry: ['server.js'],
          startTimeoutMs: 2_000,
        },
        { 'server.js': ownedNodeServerSource({ body: appId }) },
      )
      const archive = await archiveBundle(bundleDir, appId)
      const url = await serveArchive(archive)
      await runtime.install(requestFor(appId, '1.0.0', url, archive))
      await new Promise<void>(resolveClose => downloadServer!.close(() => resolveClose()))
      downloadServer = null
    }

    const owner = await runtime.start('demo.port-owner-a')
    expect(owner.port).toBe(fixedPort)
    await expect(runtime.start('demo.port-owner-b')).rejects.toMatchObject({
      code: 'PORT_UNAVAILABLE',
      details: { port: fixedPort },
    })
    expect(await (await stableFetch(owner.url)).text()).toBe('demo.port-owner-a')
    expect((await runtime.getRuntimeStatus('demo.port-owner-a')).status).toBe('running')
    expect((await runtime.getRuntimeStatus('demo.port-owner-b')).status).toBe('stopped')
  })

  it('rejects shutdown after a stop failure even when forced retry reaps the process', async () => {
    const bundleDir = await writeBundle(
      'demo.shutdown-retry',
      '1.0.0',
      { runtime: 'js', entry: ['server.js'] },
      { 'server.js': ownedNodeServerSource() },
    )
    const archive = await archiveBundle(bundleDir, 'shutdown-retry')
    const url = await serveArchive(archive)
    const runtime = makeManager({ bunPath: process.execPath })
    await runtime.install(requestFor('demo.shutdown-retry', '1.0.0', url, archive))
    await runtime.start('demo.shutdown-retry')
    const status = await runtime.getRuntimeStatus('demo.shutdown-retry')
    expect(status.pid).toBeGreaterThan(0)

    const internals = runtime as unknown as {
      killProcessTree: (...args: unknown[]) => Promise<void>
      runtimes: Map<string, unknown>
    }
    const originalKill = internals.killProcessTree.bind(runtime)
    internals.killProcessTree = async () => {
      throw new Error('injected graceful stop failure')
    }

    await expect(runtime.shutdown()).rejects.toMatchObject({
      code: 'STOP_FAILED',
    })
    expect(isProcessAlive(status.pid!)).toBe(false)
    expect(internals.runtimes.has('demo.shutdown-retry')).toBe(false)

    internals.killProcessTree = originalKill
    await expect(runtime.shutdown()).resolves.toBeUndefined()
  })

  it('retains an uncleared runtime after shutdown fallback fails and reaps it on retry', async () => {
    const bundleDir = await writeBundle(
      'demo.shutdown-retain',
      '1.0.0',
      { runtime: 'js', entry: ['server.js'] },
      { 'server.js': ownedNodeServerSource() },
    )
    const archive = await archiveBundle(bundleDir, 'shutdown-retain')
    const url = await serveArchive(archive)
    const runtime = makeManager({ bunPath: process.execPath })
    await runtime.install(requestFor('demo.shutdown-retain', '1.0.0', url, archive))
    await runtime.start('demo.shutdown-retain')
    const status = await runtime.getRuntimeStatus('demo.shutdown-retain')
    expect(status.pid).toBeGreaterThan(0)

    const internals = runtime as unknown as {
      killProcessTree: (...args: unknown[]) => Promise<void>
      forceKillProcessTree: (...args: unknown[]) => Promise<void>
      runtimes: Map<string, unknown>
    }
    const originalKill = internals.killProcessTree.bind(runtime)
    const originalForceKill = internals.forceKillProcessTree.bind(runtime)
    internals.killProcessTree = async () => {
      throw new Error('injected stop failure')
    }
    internals.forceKillProcessTree = async () => {
      throw new Error('injected fallback failure')
    }

    await expect(runtime.shutdown()).rejects.toMatchObject({
      code: 'STOP_FAILED',
    })
    expect(internals.runtimes.has('demo.shutdown-retain')).toBe(true)
    expect(isProcessAlive(status.pid!)).toBe(true)

    internals.killProcessTree = originalKill
    internals.forceKillProcessTree = originalForceKill
    await expect(runtime.shutdown()).resolves.toBeUndefined()
    expect(isProcessAlive(status.pid!)).toBe(false)
  })

  it('propagates a rejected lifecycle cleanup even when shutdown subsequently reaps the process', async () => {
    const bundleDir = await writeBundle(
      'demo.lifecycle-rejection',
      '1.0.0',
      { runtime: 'js', entry: ['server.js'] },
      { 'server.js': ownedNodeServerSource() },
    )
    const archive = await archiveBundle(bundleDir, 'lifecycle-rejection')
    const url = await serveArchive(archive)
    const runtime = makeManager({ bunPath: process.execPath })
    await runtime.install(requestFor('demo.lifecycle-rejection', '1.0.0', url, archive))
    await runtime.start('demo.lifecycle-rejection')
    const status = await runtime.getRuntimeStatus('demo.lifecycle-rejection')

    const internals = runtime as unknown as {
      killProcessTree: (...args: unknown[]) => Promise<void>
    }
    const originalKill = internals.killProcessTree.bind(runtime)
    let releaseFirstKill!: () => void
    let markFirstKillStarted!: () => void
    const firstKillStarted = new Promise<void>(resolveStarted => {
      markFirstKillStarted = resolveStarted
    })
    const releaseGate = new Promise<void>(resolveRelease => {
      releaseFirstKill = resolveRelease
    })
    let killCalls = 0
    internals.killProcessTree = async (...args: unknown[]) => {
      killCalls += 1
      if (killCalls === 1) {
        markFirstKillStarted()
        await releaseGate
        throw new Error('injected queued lifecycle cleanup failure')
      }
      return originalKill(...args)
    }

    const stop = runtime.stop('demo.lifecycle-rejection')
    await firstKillStarted
    const shutdown = runtime.shutdown()
    releaseFirstKill()

    await expect(stop).rejects.toMatchObject({ code: 'STOP_FAILED' })
    await expect(shutdown).rejects.toMatchObject({
      code: 'STOP_FAILED',
      details: {
        operationFailures: [
          expect.objectContaining({
            type: 'lifecycle',
            appId: 'demo.lifecycle-rejection',
          }),
        ],
      },
    })
    expect(isProcessAlive(status.pid!)).toBe(false)

    internals.killProcessTree = originalKill
    await expect(runtime.shutdown()).resolves.toBeUndefined()
  })

  it('runs JS and Python bundles with isolated runtime and data directories', async () => {
    const bunPath = process.execPath
    const uvPath = Bun.which('uv')
    expect(uvPath).toBeTruthy()
    const runtime = makeManager({
      bunPath,
      uvPath: uvPath!,
      baseEnvironment: {
        ...process.env,
        POLO_ADMIN_TOKEN: 'must-not-leak',
        HTTPS_PROXY: 'http://user:secret@example.invalid',
      },
    })

    const jsBundle = await writeBundle(
      'demo.js',
      '1.0.0',
      {
        runtime: 'js',
        entry: ['server.js'],
      },
      {
        'server.js': `
          const server = Bun.serve({
            hostname: '127.0.0.1',
            port: Number(process.env.PORT),
            fetch(request) {
              const path = new URL(request.url).pathname
              if (path === '/health') {
                return new Response('ok', {
                  headers: {
                    'x-polo-app-health-token': process.env.POLO_APP_HEALTH_TOKEN,
                  },
                })
              }
              return Response.json({
                appId: process.env.POLO_APP_ID,
                dataDir: process.env.POLO_APP_DATA_DIR,
                cacheDir: process.env.BUN_INSTALL_CACHE_DIR,
                path: process.env.PATH ?? null,
                adminToken: process.env.POLO_ADMIN_TOKEN ?? null,
                proxy: process.env.HTTPS_PROXY ?? null,
              })
            },
          })
          console.log('listening', server.port)
        `,
      },
    )
    await mkdir(join(jsBundle, 'local-dep'), { recursive: true })
    await writeFile(
      join(jsBundle, 'local-dep/package.json'),
      '{"name":"local-dep","version":"1.0.0","main":"index.js"}\n',
    )
    await writeFile(join(jsBundle, 'local-dep/index.js'), 'export default true\n')
    await writeFile(
      join(jsBundle, 'package.json'),
      '{"name":"demo-js","version":"1.0.0","dependencies":{"local-dep":"file:./local-dep"}}\n',
    )
    const bunInstall = Bun.spawn([bunPath, 'install', '--cwd', jsBundle], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await bunInstall.exited).toBe(0)
    await rm(join(jsBundle, 'node_modules'), { recursive: true, force: true })

    const pythonBundle = await writeBundle(
      'demo.python',
      '1.0.0',
      {
        runtime: 'python',
        entry: ['server.py'],
      },
      {
        'server.py': `
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = b"ok"
        else:
            body = json.dumps({
                "appId": os.environ["POLO_APP_ID"],
                "dataDir": os.environ["POLO_APP_DATA_DIR"],
                "venvDir": os.environ["UV_PROJECT_ENVIRONMENT"],
            }).encode()
        self.send_response(200)
        self.send_header("X-Polo-App-Health-Token", os.environ["POLO_APP_HEALTH_TOKEN"])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_args):
        pass

ThreadingHTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
        `,
      },
    )
    await writeFile(join(pythonBundle, 'pyproject.toml'), `
[project]
name = "demo-python"
version = "1.0.0"
requires-python = ">=3.11"
dependencies = []

[tool.uv]
package = false
    `.trimStart())
    const uvLock = Bun.spawn([uvPath!, 'lock', '--offline', '--project', pythonBundle], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await uvLock.exited).toBe(0)

    const jsArchive = await archiveBundle(jsBundle, 'js')
    const jsUrl = await serveArchive(jsArchive)
    await runtime.install(requestFor('demo.js', '1.0.0', jsUrl, jsArchive))
    await new Promise<void>(resolveClose => downloadServer!.close(() => resolveClose()))
    downloadServer = null

    const pythonArchive = await archiveBundle(pythonBundle, 'python')
    const pythonUrl = await serveArchive(pythonArchive)
    await runtime.install(requestFor('demo.python', '1.0.0', pythonUrl, pythonArchive))

    const jsStarted = await runtime.start('demo.js')
    const pythonStarted = await runtime.start('demo.python')
    const jsEnv = await (await stableFetch(jsStarted.url)).json() as Record<string, string>
    const pythonEnv = await (await stableFetch(pythonStarted.url)).json() as Record<string, string>

    expect(jsEnv.appId).toBe('demo.js')
    expect(pythonEnv.appId).toBe('demo.python')
    expect(jsEnv.dataDir).not.toBe(pythonEnv.dataDir)
    expect(jsEnv.cacheDir).not.toBe(pythonEnv.venvDir)
    expect(jsEnv.cacheDir).toContain('/demo.js/1.0.0/')
    expect(pythonEnv.venvDir).toContain('/demo.python/1.0.0/')
    expect(jsEnv.path).toBe(process.env.PATH!)
    expect(jsEnv.adminToken).toBeNull()
    expect(jsEnv.proxy).toBeNull()

    await runtime.stop('demo.js')
    await runtime.stop('demo.python')
    const restartedJs = await runtime.start('demo.js')
    const restartedPython = await runtime.start('demo.python')
    expect(restartedJs.version).toBe('1.0.0')
    expect(restartedPython.version).toBe('1.0.0')

    await runtime.shutdown()
    await expect(stableFetch(restartedJs.url)).rejects.toThrow()
    await expect(stableFetch(restartedPython.url)).rejects.toThrow()
  }, 60_000)

  it('rolls back a failed update and keeps user data through update and normal uninstall', async () => {
    const v1Bundle = await writeBundle(
      'demo.rollback',
      '1.0.0',
      {},
      { 'dist/index.html': 'stable-v1' },
    )
    const v1Archive = await archiveBundle(v1Bundle, 'rollback-v1')
    const v1Url = await serveArchive(v1Archive)
    const runtime = makeManager({ bunPath: process.execPath })
    await runtime.install(requestFor('demo.rollback', '1.0.0', v1Url, v1Archive))
    await runtime.start('demo.rollback')
    await runtime.stop('demo.rollback')
    await new Promise<void>(resolveClose => downloadServer!.close(() => resolveClose()))
    downloadServer = null

    const dataFile = join(testRoot, 'runtime/apps/demo.rollback/data/preferences.json')
    await writeFile(dataFile, '{"theme":"dark"}')
    const v2Bundle = await writeBundle(
      'demo.rollback',
      '2.0.0',
      {
        runtime: 'js',
        entry: ['crash.js'],
        startTimeoutMs: 1_000,
      },
      { 'crash.js': 'console.error("intentional crash"); process.exit(17)' },
    )
    const v2Archive = await archiveBundle(v2Bundle, 'rollback-v2')
    const v2Url = await serveArchive(v2Archive)
    await runtime.install(requestFor('demo.rollback', '2.0.0', v2Url, v2Archive))
    await new Promise<void>(resolveClose => downloadServer!.close(() => resolveClose()))
    downloadServer = null

    const v3Bundle = await writeBundle(
      'demo.rollback',
      '3.0.0',
      {
        runtime: 'js',
        entry: ['crash.js'],
        startTimeoutMs: 1_000,
      },
      { 'crash.js': 'console.error("second intentional crash"); process.exit(18)' },
    )
    const v3Archive = await archiveBundle(v3Bundle, 'rollback-v3')
    const v3Url = await serveArchive(v3Archive)
    await runtime.install(requestFor('demo.rollback', '3.0.0', v3Url, v3Archive))

    const started = await runtime.start('demo.rollback')
    expect(started.version).toBe('1.0.0')
    expect(started.rolledBackFrom).toBe('3.0.0')
    expect(await (await stableFetch(started.url)).text()).toContain('stable-v1')
    expect(await readFile(dataFile, 'utf8')).toContain('dark')

    await runtime.uninstall('demo.rollback')
    expect((await runtime.getRuntimeStatus('demo.rollback')).status).toBe('not_installed')
    expect(await readFile(dataFile, 'utf8')).toContain('dark')
    await runtime.uninstall('demo.rollback', { preserveData: false })
    await expect(stat(dataFile)).rejects.toThrow()
  })

  it('rejects incompatible metadata before download and preserves an installed version on checksum failure', async () => {
    const bundle = await writeBundle(
      'demo.validation',
      '1.0.0',
      {},
      { 'dist/index.html': 'valid' },
    )
    const archive = await archiveBundle(bundle, 'validation')
    let requestCount = 0
    const url = await serveArchive(archive, { onRequest: () => { requestCount += 1 } })
    const runtime = makeManager()
    const incompatible = requestFor('demo.validation', '1.0.0', url, archive)
    incompatible.arch = architecture === 'arm64' ? 'x64' : 'arm64'

    expect(() => runtime.install(incompatible)).toThrow(LocalAppRuntimeError)
    expect(requestCount).toBe(0)

    await runtime.install(requestFor('demo.validation', '1.0.0', url, archive))
    const conflictingRelease = requestFor('demo.validation', '1.0.0', url, archive)
    conflictingRelease.checksum = 'f'.repeat(64)
    await expect(runtime.install(conflictingRelease)).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
    })
    expect(requestCount).toBe(1)

    const badUpdate = requestFor('demo.validation', '2.0.0', url, archive)
    badUpdate.checksum = '0'.repeat(64)
    await expect(runtime.install(badUpdate)).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' })
    expect((await runtime.getInstalledApps())[0]?.currentVersion).toBe('1.0.0')
  })

  it('makes checksum verification observable before archive extraction', async () => {
    const bundle = await writeBundle(
      'demo.observable-verification',
      '1.0.0',
      {},
      { 'dist/index.html': 'verified' },
    )
    const archive = await archiveBundle(bundle, 'observable-verification')
    const url = await serveArchive(archive)
    const phases: string[] = []
    let resolveVerifying!: () => void
    const verifying = new Promise<void>(resolve => {
      resolveVerifying = resolve
    })
    const runtime = makeManager({
      onInstallProgress: (_appId, progress) => {
        if (phases.at(-1) !== progress.phase) phases.push(progress.phase)
        if (progress.phase === 'verifying') resolveVerifying()
      },
    })

    const installation = runtime.install(requestFor(
      'demo.observable-verification',
      '1.0.0',
      url,
      archive,
    ))
    await verifying
    expect(await runtime.getRuntimeStatus('demo.observable-verification'))
      .toMatchObject({
        status: 'installing',
        progress: { phase: 'verifying' },
      })
    await installation
    expect(phases).toEqual([
      'downloading',
      'verifying',
      'extracting',
      'preparing',
    ])
  })

  it('reports download progress and cancels an in-flight install', async () => {
    const padding = 'x'.repeat(32_000)
    const bundle = await writeBundle(
      'demo.cancel',
      '1.0.0',
      {},
      { 'dist/index.html': padding },
    )
    const archive = await archiveBundle(bundle, 'cancel')
    const url = await serveArchive(archive, { chunkDelayMs: 10 })
    const runtime = makeManager()
    const install = runtime.install(requestFor('demo.cancel', '1.0.0', url, archive))

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await runtime.getRuntimeStatus('demo.cancel')
      if (status.status === 'downloading' && (status.progress?.bytesDownloaded ?? 0) > 0) break
      await Bun.sleep(5)
    }
    const progress = await runtime.getRuntimeStatus('demo.cancel')
    expect(progress.status).toBe('downloading')
    expect(progress.progress?.bytesDownloaded).toBeGreaterThan(0)
    expect(runtime.cancelInstall('demo.cancel')).toBe(true)
    await expect(install).rejects.toMatchObject({ code: 'INSTALL_CANCELLED' })
    expect((await runtime.getRuntimeStatus('demo.cancel')).status).toBe('broken')
  })

  it('reports update installation progress alongside a running version', async () => {
    const v1Bundle = await writeBundle(
      'demo.running-update',
      '1.0.0',
      {},
      { 'dist/index.html': 'v1' },
    )
    const v1Archive = await archiveBundle(v1Bundle, 'running-update-v1')
    const v1Url = await serveArchive(v1Archive)
    const runtime = makeManager()
    await runtime.install(requestFor('demo.running-update', '1.0.0', v1Url, v1Archive))
    await runtime.start('demo.running-update')
    await new Promise<void>(resolveClose => downloadServer!.close(() => resolveClose()))
    downloadServer = null

    const v2Bundle = await writeBundle(
      'demo.running-update',
      '2.0.0',
      {},
      { 'dist/index.html': '0123456789abcdef'.repeat(4_000) },
    )
    const v2Archive = await archiveBundle(v2Bundle, 'running-update-v2')
    const v2Url = await serveArchive(v2Archive, { chunkDelayMs: 10 })
    const install = runtime.install(
      requestFor('demo.running-update', '2.0.0', v2Url, v2Archive),
    )

    let progressStatus
    for (let attempt = 0; attempt < 100; attempt += 1) {
      progressStatus = await runtime.getRuntimeStatus('demo.running-update')
      if ((progressStatus.progress?.bytesDownloaded ?? 0) > 0) break
      await Bun.sleep(5)
    }
    expect(progressStatus?.status).toBe('running')
    expect(progressStatus?.runningVersion).toBe('1.0.0')
    expect(progressStatus?.installationStatus).toBe('downloading')
    expect(progressStatus?.progress?.bytesDownloaded).toBeGreaterThan(0)

    expect(runtime.cancelInstall('demo.running-update')).toBe(true)
    await expect(install).rejects.toMatchObject({ code: 'INSTALL_CANCELLED' })
    expect((await runtime.getRuntimeStatus('demo.running-update')).status).toBe('running')
  })

  it('cancels and reaps the complete dependency preparation process tree', async () => {
    const fakeBunPath = join(testRoot, 'fake-bun')
    await writeFile(fakeBunPath, `#!${process.execPath}
      const { mkdirSync, writeFileSync } = require('fs')
      const { join } = require('path')
      const { spawn } = require('child_process')
      const dataDir = process.env.POLO_APP_DATA_DIR
      mkdirSync(dataDir, { recursive: true })
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      })
      writeFileSync(join(dataDir, 'installer-pids.json'), JSON.stringify({
        root: process.pid,
        child: child.pid,
      }))
      setInterval(() => {}, 1000)
    `)
    await chmod(fakeBunPath, 0o755)
    const bundle = await writeBundle(
      'demo.install-tree',
      '1.0.0',
      {
        runtime: 'js',
        entry: ['server.js'],
      },
      {
        'server.js': 'setInterval(() => {}, 1000)',
        'package.json': '{"name":"install-tree","version":"1.0.0"}',
        'bun.lock': 'test lock placeholder',
      },
    )
    const archive = await archiveBundle(bundle, 'install-tree')
    const url = await serveArchive(archive)
    const dataDir = join(
      testRoot,
      'runtime/apps/demo.install-tree/data',
    )
    await mkdir(dataDir, { recursive: true })
    const pidFile = join(dataDir, 'installer-pids.json')
    const pidsWritten = waitForJsonFile<{ root: number; child: number }>(pidFile)
    let dependencyStarted!: () => void
    const dependencyStart = new Promise<void>(resolve => {
      dependencyStarted = resolve
    })
    const runtime = makeManager({
      bunPath: fakeBunPath,
      onManagedProcessStarted: (appId, kind) => {
        if (appId === 'demo.install-tree' && kind === 'dependency-preparation') {
          dependencyStarted()
        }
      },
    })
    const install = runtime.install(requestFor('demo.install-tree', '1.0.0', url, archive))
    await dependencyStart
    const pids = await pidsWritten
    expect(pids.root).toBeGreaterThan(0)
    expect(pids.child).toBeGreaterThan(0)

    expect(runtime.cancelInstall('demo.install-tree')).toBe(true)
    await expect(install).rejects.toMatchObject({ code: 'INSTALL_CANCELLED' })
    expect(isProcessAlive(pids.root)).toBe(false)
    expect(isProcessAlive(pids.child)).toBe(false)
  })

  it('blocks shutdown on retained dependency cleanup handles and succeeds after retry recovery', async () => {
    const { runtime, install, pids } = await launchHangingDependencyInstall(
      'demo.install-shutdown-retain',
    )
    const internals = runtime as unknown as {
      killProcessTree: (...args: unknown[]) => Promise<void>
      forceKillProcessTree: (...args: unknown[]) => Promise<void>
      managedProcesses: Map<string, unknown>
    }
    const originalKill = internals.killProcessTree.bind(runtime)
    const originalForceKill = internals.forceKillProcessTree.bind(runtime)
    internals.killProcessTree = async () => {
      throw new Error('injected dependency abort cleanup failure')
    }
    internals.forceKillProcessTree = async () => {
      throw new Error('injected dependency forced cleanup failure')
    }

    const shutdown = runtime.shutdown()
    await expect(install).rejects.toMatchObject({ code: 'STOP_FAILED' })
    await expect(shutdown).rejects.toMatchObject({ code: 'STOP_FAILED' })
    expect(internals.managedProcesses.size).toBe(1)
    expect(isProcessAlive(pids.root)).toBe(true)

    internals.killProcessTree = originalKill
    internals.forceKillProcessTree = originalForceKill
    await expect(runtime.shutdown()).resolves.toBeUndefined()
    expect(internals.managedProcesses.size).toBe(0)
    expect(isProcessAlive(pids.root)).toBe(false)
    expect(isProcessAlive(pids.child)).toBe(false)
  })

  it('blocks uninstall on retained dependency cleanup handles and removes files only after retry recovery', async () => {
    const appId = 'demo.install-uninstall-retain'
    const { runtime, install, pids } = await launchHangingDependencyInstall(appId)
    const internals = runtime as unknown as {
      killProcessTree: (...args: unknown[]) => Promise<void>
      forceKillProcessTree: (...args: unknown[]) => Promise<void>
      managedProcesses: Map<string, unknown>
    }
    const originalKill = internals.killProcessTree.bind(runtime)
    const originalForceKill = internals.forceKillProcessTree.bind(runtime)
    internals.killProcessTree = async () => {
      throw new Error('injected dependency abort cleanup failure')
    }
    internals.forceKillProcessTree = async () => {
      throw new Error('injected dependency forced cleanup failure')
    }

    const uninstall = runtime.uninstall(appId, { preserveData: false })
    await expect(install).rejects.toMatchObject({ code: 'STOP_FAILED' })
    await expect(uninstall).rejects.toMatchObject({ code: 'UNINSTALL_FAILED' })
    expect(internals.managedProcesses.size).toBe(1)
    expect(isProcessAlive(pids.root)).toBe(true)
    expect(await stat(join(testRoot, `runtime/apps/${appId}/data`))).toBeTruthy()

    internals.killProcessTree = originalKill
    internals.forceKillProcessTree = originalForceKill
    await expect(runtime.uninstall(appId, { preserveData: false })).resolves.toBeUndefined()
    expect(internals.managedProcesses.size).toBe(0)
    expect(isProcessAlive(pids.root)).toBe(false)
    expect(isProcessAlive(pids.child)).toBe(false)
    await expect(stat(join(testRoot, `runtime/apps/${appId}`))).rejects.toThrow()
  })

  it('registers a Windows gate before Job Object assignment and confirms cleanup on binding failure', async () => {
    const gate = makeFakeChild(41_001)
    let taskkillCalls = 0
    let directKillCalls = 0
    gate.kill = () => {
      directKillCalls += 1
      return true
    }
    let internals!: WindowsGateInternals
    const owner = {
      assignProcess: () => {
        expect(internals.managedProcesses.size).toBe(1)
        throw new Error('injected Job Object binding failure')
      },
      setSnapshotFallback: () => {},
      terminate: async () => {
        expect(internals.managedProcesses.size).toBe(1)
      },
    } as unknown as WindowsJobObjectOwner
    const created = makeWindowsGateManager({
      gate,
      owner,
      onTaskkill: () => {
        taskkillCalls += 1
      },
    })
    internals = created.internals

    await expect(internals.spawnManagedCommand(
      'demo.windows-binding',
      'dependency-preparation',
      'bun.exe',
      ['install'],
      testRoot,
      {},
    )).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
      details: { cause: 'injected Job Object binding failure' },
    })
    expect(internals.managedProcesses.size).toBe(0)
    expect(taskkillCalls).toBe(1)
    expect(directKillCalls).toBe(0)
  })

  it('routes Windows gate stdin delivery failure through owner-confirmed cleanup', async () => {
    const failedStdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        callback(new Error('injected gate stdin failure'))
      },
    })
    const gate = makeFakeChild(41_002, failedStdin)
    let internals!: WindowsGateInternals
    let terminateCalls = 0
    const owner = {
      assignProcess: () => {
        expect(internals.managedProcesses.size).toBe(1)
      },
      setSnapshotFallback: () => {},
      terminate: async () => {
        terminateCalls += 1
        expect(internals.managedProcesses.size).toBe(1)
        markFakeChildExited(gate)
      },
    } as unknown as WindowsJobObjectOwner
    const created = makeWindowsGateManager({ gate, owner })
    internals = created.internals

    await expect(internals.spawnManagedCommand(
      'demo.windows-stdin',
      'dependency-preparation',
      'uv.exe',
      ['sync'],
      testRoot,
      {},
    )).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
      details: { cause: 'injected gate stdin failure' },
    })
    expect(terminateCalls).toBe(1)
    expect(internals.managedProcesses.size).toBe(0)
  })

  it('blocks shutdown after Windows gate cleanup failure and releases it only after owner retry succeeds', async () => {
    const failedStdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        callback(new Error('injected gate stdin failure'))
      },
    })
    const gate = makeFakeChild(41_003, failedStdin)
    let shouldFailTermination = true
    let terminateCalls = 0
    const owner = {
      assignProcess: () => {},
      setSnapshotFallback: () => {},
      terminate: async () => {
        terminateCalls += 1
        if (shouldFailTermination) {
          throw new Error('injected owner termination failure')
        }
        markFakeChildExited(gate)
      },
    } as unknown as WindowsJobObjectOwner
    const { runtime, internals } = makeWindowsGateManager({ gate, owner })

    await expect(internals.spawnManagedCommand(
      'demo.windows-shutdown',
      'dependency-preparation',
      'bun.exe',
      ['install'],
      testRoot,
      {},
    )).rejects.toMatchObject({
      code: 'STOP_FAILED',
      details: {
        cause: 'injected gate stdin failure',
        cleanupError: expect.stringContaining('could not be fully terminated'),
      },
    })
    expect(internals.managedProcesses.size).toBe(1)
    await expect(runtime.shutdown()).rejects.toMatchObject({ code: 'STOP_FAILED' })
    expect(internals.managedProcesses.size).toBe(1)
    // The PID fallback may stop the gate, but that cannot prove descendants
    // are gone after Job Object termination failed, so the owner is retained.
    expect(gate.exitCode).toBe(0)

    shouldFailTermination = false
    await expect(runtime.shutdown()).resolves.toBeUndefined()
    expect(internals.managedProcesses.size).toBe(0)
    expect(gate.exitCode).toBe(0)
    expect(terminateCalls).toBeGreaterThanOrEqual(4)
  })

  it('blocks uninstall with a retained unassigned Windows gate until owner cleanup recovers', async () => {
    const appId = 'demo.windows-uninstall'
    const gate = makeFakeChild(41_004)
    let shouldFailTermination = true
    let taskkillCalls = 0
    const owner = {
      assignProcess: () => {
        throw new Error('injected Job Object binding failure')
      },
      setSnapshotFallback: () => {},
      terminate: async () => {
        if (shouldFailTermination) {
          throw new Error('injected owner termination failure')
        }
      },
    } as unknown as WindowsJobObjectOwner
    const { runtime, internals } = makeWindowsGateManager({
      gate,
      owner,
      onTaskkill: () => {
        taskkillCalls += 1
      },
    })

    await expect(internals.spawnManagedCommand(
      appId,
      'dependency-preparation',
      'uv.exe',
      ['sync'],
      testRoot,
      {},
    )).rejects.toMatchObject({ code: 'STOP_FAILED' })
    expect(internals.managedProcesses.size).toBe(1)
    expect(taskkillCalls).toBe(1)
    await expect(runtime.uninstall(appId, { preserveData: false })).rejects.toMatchObject({
      code: 'UNINSTALL_FAILED',
    })
    expect(internals.managedProcesses.size).toBe(1)

    shouldFailTermination = false
    await expect(runtime.uninstall(appId, { preserveData: false })).resolves.toBeUndefined()
    expect(internals.managedProcesses.size).toBe(0)
  })

  it('rejects an empty static entry and unsupported host permissions', async () => {
    expect(() => validatePoloAppManifest({
      schemaVersion: 1,
      appId: 'demo.permission',
      version: '1.0.0',
      runtime: 'static',
      entry: ['dist'],
      healthcheck: '/health',
      webPath: '/',
      permissions: ['polo.credentials.read'],
    }, { platform, arch: architecture })).toThrow(LocalAppRuntimeError)

    const bundle = await writeBundle('demo.empty-static', '1.0.0')
    await mkdir(join(bundle, 'dist'), { recursive: true })
    const archive = await archiveBundle(bundle, 'empty-static')
    const url = await serveArchive(archive)
    const runtime = makeManager()
    await expect(
      runtime.install(requestFor('demo.empty-static', '1.0.0', url, archive)),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
  })

  it('rejects shell-string entries and archive path traversal before writing outside staging', async () => {
    expect(() => validatePoloAppManifest({
      schemaVersion: 1,
      appId: 'demo.bad',
      version: '1.0.0',
      runtime: 'js',
      entry: 'bun server.js && open /tmp/pwned',
      healthcheck: '/health',
      webPath: '/',
      permissions: [],
    }, { platform, arch: architecture })).toThrow(LocalAppRuntimeError)

    const archivePath = join(testRoot, 'traversal.zip')
    const destination = join(testRoot, 'extracted')
    const escaped = join(testRoot, 'escaped.txt')
    await writeFile(archivePath, makeStoredZip('../escaped.txt', Buffer.from('unsafe')))
    await expect(extractBundleArchive(archivePath, destination)).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE',
    })
    await expect(stat(escaped)).rejects.toThrow()

    const safeZipPath = join(testRoot, 'safe.zip')
    const safeDestination = join(testRoot, 'safe-output')
    await writeFile(safeZipPath, makeStoredZip('safe.txt', Buffer.from('streamed')))
    await extractBundleArchive(safeZipPath, safeDestination)
    expect(await readFile(join(safeDestination, 'safe.txt'), 'utf8')).toBe('streamed')

    const bombPath = join(testRoot, 'compression-bomb.zip')
    await writeFile(
      bombPath,
      makeDeflatedZip('huge.txt', Buffer.alloc(2 * 1024 * 1024, 0x61)),
    )
    await expect(
      extractBundleArchive(bombPath, join(testRoot, 'bomb-output')),
    ).rejects.toMatchObject({ code: 'UNSAFE_ARCHIVE' })
  })
})
