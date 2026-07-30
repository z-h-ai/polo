import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const root = join(import.meta.dir, '..')
const electronDir = join(root, 'apps', 'electron')
const cliPath = join(electronDir, 'dist', 'cli', 'polo-cli.js')
const serverPath = join(electronDir, 'dist', 'server', 'polo-server.js')
const manifestPath = join(electronDir, 'dist', 'cli', 'artifact-manifest.json')
const unixWrapper = join(electronDir, 'resources', 'bin', 'polo')
const windowsWrapper = join(electronDir, 'resources', 'bin', 'polo.cmd')
const windowsInstaller = join(electronDir, 'resources', 'scripts', 'windows-terminal-integration.ps1')
const nsisInclude = join(electronDir, 'build', 'installer.nsh')

for (const path of [
  cliPath,
  serverPath,
  manifestPath,
  unixWrapper,
  windowsWrapper,
  windowsInstaller,
  nsisInclude,
]) {
  if (!existsSync(path)) throw new Error(`Required packaged artifact is missing: ${path}`)
}

const versions = [
  'package.json',
  'apps/electron/package.json',
  'apps/cli/package.json',
  'packages/server/package.json',
].map((path) => ({
  path,
  version: JSON.parse(readFileSync(join(root, path), 'utf8')).version as string,
}))
if (new Set(versions.map(({ version }) => version)).size !== 1) {
  throw new Error(`CLI/App/server version mismatch: ${JSON.stringify(versions)}`)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  version?: string
  artifacts?: {
    cli?: { path?: string; sha256?: string }
    server?: { path?: string; sha256?: string }
  }
}
if (manifest.version !== versions[0].version) {
  throw new Error(`Artifact manifest version ${manifest.version} does not match App ${versions[0].version}`)
}
if (
  manifest.artifacts?.cli?.path !== 'dist/cli/polo-cli.js'
  || manifest.artifacts?.server?.path !== 'dist/server/polo-server.js'
) {
  throw new Error('Artifact manifest contains unexpected paths')
}
const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')
if (
  manifest.artifacts.cli.sha256 !== sha256(cliPath)
  || manifest.artifacts.server.sha256 !== sha256(serverPath)
) {
  throw new Error('Artifact manifest checksums do not match the CLI/server bundles')
}

const wrapper = readFileSync(unixWrapper, 'utf8')
const windows = readFileSync(windowsWrapper, 'utf8')
if (!wrapper.includes('dist/cli/polo-cli.js') || !windows.includes('dist\\cli\\polo-cli.js')) {
  throw new Error('A Polo launcher does not point at the packaged CLI bundle')
}

const bundledBun = join(electronDir, 'vendor', 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
if (process.env.POLO_AI_REQUIRE_BUNDLED_RUNTIME === '1' && !existsSync(bundledBun)) {
  throw new Error(`Bundled Bun runtime is missing: ${bundledBun}`)
}
const bunExecutable = existsSync(bundledBun) ? bundledBun : process.execPath
const versionCheck = Bun.spawnSync([bunExecutable, 'run', cliPath, '--version'], {
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, POLO_AI_RUNTIME_DISCOVERY_FILE: join(electronDir, '.validation-runtime.json') },
})
if (versionCheck.exitCode !== 0) {
  throw new Error(`Packaged CLI --version failed: ${versionCheck.stderr.toString()}`)
}
const actualVersion = versionCheck.stdout.toString().trim()
if (actualVersion !== versions[0].version) {
  throw new Error(`Packaged CLI reports ${actualVersion}; expected ${versions[0].version}`)
}

const helpCheck = Bun.spawnSync([bunExecutable, 'run', cliPath, '--help'], {
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, POLO_AI_RUNTIME_DISCOVERY_FILE: join(electronDir, '.validation-runtime.json') },
})
if (helpCheck.exitCode !== 0 || !helpCheck.stdout.toString().includes('Usage: polo ')) {
  throw new Error(`Packaged CLI --help failed: ${helpCheck.stderr.toString()}`)
}

console.log(`✓ Packaged CLI artifacts validated (${actualVersion})`)
