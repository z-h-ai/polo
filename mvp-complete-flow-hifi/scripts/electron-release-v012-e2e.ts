import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const rootDirectory = join(import.meta.dir, '..')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'polo-release-v012-e2e-'))
const configDirectory = join(temporaryDirectory, 'config')
const workspaceDirectory = join(temporaryDirectory, 'workspace')
const bundleDirectory = join(temporaryDirectory, 'bundle')
const bundlePath = join(temporaryDirectory, 'static-v1.tar.gz')
const mainOutput = join(temporaryDirectory, 'main.cjs')
const preloadOutput = join(temporaryDirectory, 'bootstrap-preload.cjs')
const rendererHtml = join(rootDirectory, 'apps/electron/dist/renderer/index.html')
const electronExecutable = require('electron') as string

async function main(): Promise<void> {
  mkdirSync(configDirectory, { recursive: true })
  mkdirSync(workspaceDirectory, { recursive: true })
  mkdirSync(join(bundleDirectory, 'dist'), { recursive: true })
  writeFileSync(join(bundleDirectory, 'polo-app.json'), JSON.stringify({
    schemaVersion: 1,
    appId: 'release-v012-static',
    version: '1.0.0',
    name: 'Release v0.12 Static Fixture',
    runtime: 'static',
    entry: ['dist/index.html'],
    healthcheck: '/health',
    webPath: '/app',
    permissions: [],
  }, null, 2))
  writeFileSync(
    join(bundleDirectory, 'dist/index.html'),
    '<!doctype html><html><body><h1>release-v012-static-ready</h1></body></html>',
  )
  execFileSync('tar', ['-czf', bundlePath, '-C', bundleDirectory, '.'])
  const bundle = Bun.file(bundlePath)
  const checksum = createHash('sha256')
    .update(Buffer.from(await bundle.arrayBuffer()))
    .digest('hex')
  const sizeBytes = statSync(bundlePath).size

  writeFileSync(join(configDirectory, 'config.json'), JSON.stringify({
    workspaces: [{
      id: 'release-v012-workspace',
      name: 'Release v0.12 E2E',
      slug: 'release-v012-e2e',
      rootPath: workspaceDirectory,
      createdAt: Date.now(),
    }],
    activeWorkspaceId: 'release-v012-workspace',
    activeSessionId: null,
    setupDeferred: true,
  }, null, 2))

  execFileSync('bun', ['run', 'electron:build:renderer'], {
    cwd: rootDirectory,
    stdio: 'inherit',
  })
  await Promise.all([
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/release-v012/main.ts'],
      external: ['electron', 'koffi'],
      format: 'cjs',
      outfile: mainOutput,
      platform: 'node',
    }),
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      define: { __POLO_AI_TRUSTED_PHONE_AUTH_E2E__: 'true' },
      entryPoints: ['apps/electron/src/preload/bootstrap.ts'],
      external: ['electron'],
      format: 'cjs',
      outfile: preloadOutput,
      platform: 'node',
    }),
  ])

  const electron = Bun.spawn([
    electronExecutable,
    mainOutput,
    preloadOutput,
    rendererHtml,
    bundlePath,
    checksum,
    String(sizeBytes),
  ], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      POLO_AI_CONFIG_DIR: configDirectory,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await electron.exited
  if (exitCode !== 0) throw new Error(`Release v0.12 Electron E2E exited with ${exitCode}`)
}

try {
  await main()
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
