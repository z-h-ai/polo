import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  removeElectronRuntimeDiscovery,
  writeElectronRuntimeDiscovery,
} from '../packages/shared/src/runtime-discovery'
import { version } from '../package.json'

const root = join(import.meta.dir, '..')
const cli = join(root, 'apps', 'electron', 'dist', 'cli', 'polo-cli.js')
const server = join(root, 'apps', 'electron', 'dist', 'server', 'polo-server.js')
const testRoot = mkdtempSync(join(tmpdir(), 'polo packaged 项目 '))
const workingDirectory = join(testRoot, 'workspace with spaces')
const discoveryPath = join(testRoot, 'runtime', 'electron.json')
const configDir = join(testRoot, 'config')
const token = crypto.randomUUID()
mkdirSync(workingDirectory, { recursive: true })

if (process.platform !== 'win32') {
  const packagedResources = join(testRoot, 'Polo 产品', 'Contents', 'Resources')
  const packagedApp = join(packagedResources, 'app')
  const packagedBin = join(packagedApp, 'resources', 'bin')
  const userBin = join(testRoot, '用户 home', '.local', 'bin')
  mkdirSync(join(packagedResources, 'vendor', 'bun'), { recursive: true })
  mkdirSync(join(packagedApp, 'dist', 'cli'), { recursive: true })
  mkdirSync(join(packagedApp, 'dist', 'server'), { recursive: true })
  mkdirSync(packagedBin, { recursive: true })
  mkdirSync(userBin, { recursive: true })
  symlinkSync(process.execPath, join(packagedResources, 'vendor', 'bun', 'bun'))
  copyFileSync(cli, join(packagedApp, 'dist', 'cli', 'polo-cli.js'))
  copyFileSync(server, join(packagedApp, 'dist', 'server', 'polo-server.js'))
  const packagedWrapper = join(packagedBin, 'polo')
  copyFileSync(join(root, 'apps', 'electron', 'resources', 'bin', 'polo'), packagedWrapper)
  chmodSync(packagedWrapper, 0o755)
  const installedLauncher = join(userBin, 'polo')
  symlinkSync(packagedWrapper, installedLauncher)

  const wrapperCheck = Bun.spawnSync([installedLauncher, '--version'], {
    cwd: workingDirectory,
    env: { ...process.env, POLO_AI_RUNTIME_DISCOVERY_FILE: discoveryPath },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (wrapperCheck.exitCode !== 0 || wrapperCheck.stdout.toString().trim() !== version) {
    throw new Error(`Self-relative launcher validation failed: ${wrapperCheck.stderr.toString()}`)
  }
}

const env = {
  ...process.env,
  POLO_AI_CONFIG_DIR: configDir,
  POLO_AI_RUNTIME_DISCOVERY_FILE: discoveryPath,
  POLO_AI_SERVER_TOKEN: token,
  POLO_AI_RPC_HOST: '127.0.0.1',
  POLO_AI_RPC_PORT: '0',
  POLO_AI_VERSION: version,
  POLO_AI_BUNDLED_ASSETS_ROOT: root,
}

const proc = Bun.spawn([process.execPath, 'run', server], {
  cwd: workingDirectory,
  env,
  stdout: 'pipe',
  stderr: 'pipe',
})

async function waitForServerUrl(): Promise<string> {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Packaged server startup timed out')), remaining)),
    ])
    if (result.done) break
    buffer += decoder.decode(result.value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('POLO_AI_SERVER_URL=')) {
        return line.slice('POLO_AI_SERVER_URL='.length).trim()
      }
    }
  }
  throw new Error('Packaged server exited before publishing its URL')
}

try {
  const url = await waitForServerUrl()
  writeElectronRuntimeDiscovery({
    pid: proc.pid,
    url,
    token,
    version,
  }, { path: discoveryPath })

  const cliCheck = Bun.spawnSync([process.execPath, 'run', cli, 'workspaces'], {
    cwd: workingDirectory,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (cliCheck.exitCode !== 0) {
    throw new Error(`Packaged CLI discovery check failed: ${cliCheck.stderr.toString()}`)
  }
  if (!cliCheck.stdout.toString().includes('No workspaces found')) {
    throw new Error(`Unexpected packaged CLI output: ${cliCheck.stdout.toString()}`)
  }

  console.log('✓ Packaged CLI discovered and connected to the packaged server')
  console.log('✓ Self-relative launcher passed through an installed symlink')
  console.log('✓ Runtime validation passed from a path containing spaces and non-ASCII characters')
} finally {
  removeElectronRuntimeDiscovery({ path: discoveryPath, expectedPid: proc.pid })
  proc.kill('SIGTERM')
  await Promise.race([
    proc.exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (proc.exitCode === null) proc.kill('SIGKILL')
  rmSync(testRoot, { recursive: true, force: true })
}
