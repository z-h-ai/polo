import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const rootDirectory = join(import.meta.dir, '..')
const pol53SourceDirectory = process.env.POL53_WORKTREE?.trim()
  || '/Users/wow/project/z-h-ai/polo-admin-dir/POL-53/feat/phone-auth-registration'
const databaseUrl = process.env.POL53_E2E_DATABASE_URL?.trim()
  || 'postgresql://postgres:postgres@localhost:5432/polo_admin_test'
const providerPort = Number(process.env.POL53_E2E_PROVIDER_PORT || 39053)
const adminPort = Number(process.env.POL53_E2E_ADMIN_PORT || 39054)
const providerBaseUrl = `http://127.0.0.1:${providerPort}`
const adminBaseUrl = `http://127.0.0.1:${adminPort}`
const bearerToken = randomBytes(32).toString('base64url')
const phone = `139${randomBytes(4).readUInt32BE(0).toString().padStart(10, '0').slice(0, 8)}`
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'polo-phone-auth-e2e-'))
const pol53Directory = join(temporaryDirectory, 'pol53')
const configDirectory = join(temporaryDirectory, 'config')
const mainOutput = join(temporaryDirectory, 'main.cjs')
const preloadOutput = join(temporaryDirectory, 'bootstrap-preload.cjs')
const rendererOutput = join(temporaryDirectory, 'renderer.js')
const rendererHtml = join(temporaryDirectory, 'renderer.html')
const electronExecutable = require('electron') as string
let pol53Runner: ReturnType<typeof Bun.spawn> | undefined

function validateSafetyBoundaries(): void {
  const url = new URL(databaseUrl)
  const databaseName = url.pathname.replace(/^\//, '')
  const loopback = (
    url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
  )
  if (!loopback || databaseName !== 'polo_admin_test') {
    throw new Error(
      `Refusing Electron phone-auth E2E database ${url.hostname}/${databaseName}`,
    )
  }
  for (const port of [providerPort, adminPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('POL-53 E2E ports must be valid TCP ports')
    }
  }
}

function runChecked(command: string[], cwd: string, env?: Record<string, string>): void {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stderr: 'inherit',
    stdout: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${command.join(' ')}`)
  }
}

async function waitForPol53(): Promise<void> {
  const discoveryUrl = `${adminBaseUrl}/api/auth/phone/challenge/config`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (pol53Runner?.exitCode !== null) {
      throw new Error(`POL-53 runner exited early with ${pol53Runner.exitCode}`)
    }
    try {
      const response = await fetch(discoveryUrl)
      if (response.ok) {
        const body = await response.json() as { type?: string; issuerUrl?: string }
        if (
          body.type === 'browser_redirect'
          && body.issuerUrl === `${providerBaseUrl}/challenge`
        ) {
          console.log(JSON.stringify({
            event: 'pol53_ready',
            database: 'polo_admin_test',
            discoveryUrl,
            issuerUrl: body.issuerUrl,
          }))
          return
        }
      }
    } catch {
      // The real Next.js service may still be compiling its first route.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for the POL-53 discovery endpoint')
}

async function buildElectronFixture(): Promise<void> {
  mkdirSync(configDirectory, { recursive: true })
  writeFileSync(join(configDirectory, 'config.json'), JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    adminUrl: adminBaseUrl,
  }, null, 2))
  writeFileSync(rendererHtml, [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src ws://127.0.0.1:* http://127.0.0.1:*">',
    '<link rel="stylesheet" href="./renderer.css">',
    '</head>',
    '<body><div id="root"></div><script src="./renderer.js"></script></body>',
    '</html>',
  ].join('\n'))

  await Promise.all([
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/phone-auth/main.ts'],
      external: ['electron'],
      format: 'cjs',
      outfile: mainOutput,
      platform: 'node',
    }),
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/src/preload/bootstrap.ts'],
      external: ['electron'],
      format: 'cjs',
      outfile: preloadOutput,
      platform: 'node',
    }),
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/phone-auth/renderer.tsx'],
      format: 'iife',
      outfile: rendererOutput,
      platform: 'browser',
      tsconfig: 'apps/electron/tsconfig.json',
      loader: {
        '.ttf': 'dataurl',
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
      },
      plugins: [{
        name: 'vite-url-import-stub',
        setup(buildContext) {
          buildContext.onResolve({ filter: /\?url$/ }, args => ({
            path: args.path,
            namespace: 'vite-url-stub',
          }))
          buildContext.onLoad({ filter: /.*/, namespace: 'vite-url-stub' }, () => ({
            contents: 'export default ""',
            loader: 'js',
          }))
        },
      }],
    }),
  ])
}

async function main(): Promise<void> {
  validateSafetyBoundaries()
  const pol53Head = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
    cwd: pol53SourceDirectory,
  }).stdout.toString().trim()
  if (pol53Head !== '6e6455a') {
    throw new Error(`Expected POL-53 HEAD 6e6455a, received ${pol53Head || 'unknown'}`)
  }

  // Run the upstream service from an isolated local clone. Next.js rewrites
  // next-env.d.ts during startup, so executing inside the dependency worktree
  // would violate the read-only boundary even if the file were restored later.
  runChecked([
    'git',
    'clone',
    '--local',
    '--no-hardlinks',
    '--no-checkout',
    pol53SourceDirectory,
    pol53Directory,
  ], temporaryDirectory)
  runChecked(['git', 'checkout', '--detach', pol53Head], pol53Directory)
  runChecked([
    'cp',
    '-cR',
    join(pol53SourceDirectory, 'node_modules'),
    join(pol53Directory, 'node_modules'),
  ], temporaryDirectory)

  runChecked(['npm', 'run', 'db:seed-test'], pol53Directory, {
    DATABASE_URL: databaseUrl,
  })

  pol53Runner = Bun.spawn(['npm', 'run', 'dev:phone-auth-e2e'], {
    cwd: pol53Directory,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PHONE_AUTH_E2E_BEARER_TOKEN: bearerToken,
      PHONE_AUTH_E2E_PROVIDER_PORT: String(providerPort),
      PHONE_AUTH_E2E_ADMIN_PORT: String(adminPort),
    },
    stderr: 'inherit',
    stdout: 'inherit',
  })

  await waitForPol53()
  await buildElectronFixture()

  const electron = Bun.spawn([
    electronExecutable,
    mainOutput,
    preloadOutput,
    rendererHtml,
    providerBaseUrl,
    bearerToken,
    phone,
  ], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      POLO_AI_CONFIG_DIR: configDirectory,
      POLO_AI_PHONE_AUTH_E2E: 'true',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await electron.exited
  if (exitCode !== 0) {
    throw new Error(`Native Electron phone auth E2E exited with ${exitCode}`)
  }
}

try {
  await main()
} finally {
  pol53Runner?.kill('SIGTERM')
  if (pol53Runner) await pol53Runner.exited
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
