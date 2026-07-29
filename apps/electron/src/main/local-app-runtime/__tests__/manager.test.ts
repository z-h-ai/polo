import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import * as tar from 'tar'
import { fetch as undiciFetch } from 'undici'
import type {
  LocalAppArchitecture,
  LocalAppInstallRequest,
  LocalAppPlatform,
  PoloAppManifest,
} from '@polo-ai/shared/protocol'
import { LocalAppRuntimeManager } from '../manager'
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

function makeManager(options: { uvPath?: string; bunPath?: string } = {}): LocalAppRuntimeManager {
  manager = new LocalAppRuntimeManager({
    rootDir: join(testRoot, 'runtime'),
    platform,
    arch: architecture,
    fetch: stableFetch,
    ...options,
  })
  return manager
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

describe('LocalAppRuntimeManager', () => {
  it('installs, starts, stops, and idempotently restarts a static bundle', async () => {
    const bundleDir = await writeBundle(
      'demo.static',
      '1.0.0',
      { webPath: '/app' },
      { 'dist/index.html': '<h1>static-ready</h1>' },
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

    const started = await runtime.start('demo.static')
    expect(started.url).toContain('/app')
    expect(await (await stableFetch(started.url)).text()).toContain('static-ready')
    expect((await runtime.getRuntimeStatus('demo.static')).status).toBe('running')

    await runtime.stop('demo.static')
    expect((await runtime.getRuntimeStatus('demo.static')).status).toBe('stopped')
    const restarted = await runtime.start('demo.static')
    expect(await (await stableFetch(restarted.url)).text()).toContain('static-ready')

    const logs = await runtime.getLogs('demo.static')
    expect(logs).toContain('Installed 1.0.0')
    expect(logs).toContain('Healthy at')
  })

  it('runs JS and Python bundles with isolated runtime and data directories', async () => {
    const bunPath = process.execPath
    const uvPath = Bun.which('uv')
    expect(uvPath).toBeTruthy()
    const runtime = makeManager({ bunPath, uvPath: uvPath! })

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
              if (path === '/health') return new Response('ok')
              return Response.json({
                appId: process.env.POLO_APP_ID,
                dataDir: process.env.POLO_APP_DATA_DIR,
                cacheDir: process.env.BUN_INSTALL_CACHE_DIR,
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

    const started = await runtime.start('demo.rollback')
    expect(started.version).toBe('1.0.0')
    expect(started.rolledBackFrom).toBe('2.0.0')
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
    const badUpdate = requestFor('demo.validation', '2.0.0', url, archive)
    badUpdate.checksum = '0'.repeat(64)
    await expect(runtime.install(badUpdate)).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' })
    expect((await runtime.getInstalledApps())[0]?.currentVersion).toBe('1.0.0')
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
  })
})
