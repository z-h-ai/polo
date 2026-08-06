import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const rootDirectory = join(import.meta.dir, '..')
const adminBaseUrl = process.env.POO21_ADMIN_BASE_URL?.trim() || 'http://127.0.0.1:3000'
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'polo-creator-skill-e2e-'))
const workspaceRoot = join(temporaryDirectory, 'workspace')
const configDirectory = join(temporaryDirectory, 'config')
const blankHtmlPath = join(temporaryDirectory, 'blank.html')
const mainOutput = join(temporaryDirectory, 'main.cjs')
const preloadOutput = join(temporaryDirectory, 'bootstrap-preload.cjs')
const rendererHarnessOutput = join(temporaryDirectory, 'renderer-harness.js')
const electronExecutable = require('electron') as string

function validateLoopback(urlValue: string): void {
  const url = new URL(urlValue)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (!loopback) {
    throw new Error(`Refusing non-loopback admin base URL: ${urlValue}`)
  }
}

async function preflightAdminLoopback(urlValue: string): Promise<void> {
  const endpoint = new URL('/api/auth/config', urlValue)
  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Creator Skill admin loopback is unavailable at ${urlValue}: ${reason}`)
  }
}

async function main(): Promise<void> {
  validateLoopback(adminBaseUrl)
  await preflightAdminLoopback(adminBaseUrl)
  const blankHtml = '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="./renderer-harness.js"></script></body></html>'
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(configDirectory, { recursive: true })
  symlinkSync(join(rootDirectory, 'node_modules'), join(temporaryDirectory, 'node_modules'), 'dir')
  writeFileSync(blankHtmlPath, blankHtml)
  writeFileSync(join(configDirectory, 'config.json'), JSON.stringify({
    workspaces: [{
      id: 'creator-skill-e2e-workspace',
      name: 'Creator Skill E2E',
      slug: 'creator-skill-e2e',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }],
    activeWorkspaceId: 'creator-skill-e2e-workspace',
    activeSessionId: 'creator-skill-e2e-session',
    adminUrl: adminBaseUrl,
  }, null, 2))

  await Promise.all([
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/creator-skill/main.ts'],
      external: ['electron', 'koffi'],
      format: 'cjs',
      outfile: mainOutput,
      platform: 'node',
    }),
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      define: {
        __POLO_AI_TRUSTED_PHONE_AUTH_E2E__: 'true',
      },
      entryPoints: ['apps/electron/src/preload/bootstrap.ts'],
      external: ['electron'],
      format: 'cjs',
      outfile: preloadOutput,
      platform: 'node',
    }),
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/creator-skill/renderer.ts'],
      format: 'iife',
      outfile: rendererHarnessOutput,
      platform: 'browser',
    }),
  ])

  const electron = Bun.spawn([
    electronExecutable,
    mainOutput,
    preloadOutput,
    blankHtmlPath,
    adminBaseUrl,
    workspaceRoot,
  ], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      POLO_AI_CONFIG_DIR: configDirectory,
      POLO_AI_WORKSPACE_ID: 'creator-skill-e2e-workspace',
      POLO_AI_SERVER_URL: '',
      POLO_AI_SERVER_TOKEN: '',
      POLO_AI_DISABLE_AUTO_OPEN: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stderr: 'inherit',
    stdout: 'inherit',
  })

  const exitCode = await electron.exited
  if (exitCode !== 0) {
    throw new Error(`Creator Skill Electron E2E exited with code ${exitCode}`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
