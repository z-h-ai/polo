#!/usr/bin/env bun

import { $ } from 'bun'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  buildMcpServers,
  copyInterceptor,
  copyPiAgentServer,
  copyRipgrep,
  copySDK,
  copySessionServer,
  downloadBun,
  verifySDKCopy,
  type Arch,
  type BuildConfig,
  type Platform,
} from './build/common'

export interface PreparePlatformRuntimeOptions {
  platform: Platform
  arch: Arch
  rootDir: string
  electronDir: string
  bunSource?: string
}

function sdkPackageName(platform: Platform, arch: Arch): string {
  return `claude-agent-sdk-${platform === 'win32' ? 'win32' : platform}-${arch}`
}

async function ensureSdkBinaryPackage(options: PreparePlatformRuntimeOptions): Promise<void> {
  const packageName = sdkPackageName(options.platform, options.arch)
  const destination = join(options.rootDir, 'node_modules', '@anthropic-ai', packageName)
  if (existsSync(destination)) return

  const rootPackage = await Bun.file(join(options.rootDir, 'package.json')).json() as {
    dependencies?: Record<string, string>
  }
  const version = rootPackage.dependencies?.['@anthropic-ai/claude-agent-sdk']
  if (!version) {
    throw new Error('Unable to resolve @anthropic-ai/claude-agent-sdk version')
  }

  const tempDir = join(options.electronDir, '.sdk-runtime-prepare')
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })
  try {
    await $`npm pack ${`@anthropic-ai/${packageName}@${version}`} --pack-destination ${tempDir}`.quiet()
    const tarball = readdirSync(tempDir).find((entry) => entry.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm pack did not produce ${packageName}`)
    const extractDir = join(tempDir, 'extract')
    mkdirSync(extractDir, { recursive: true })
    await $`tar -xzf ${join(tempDir, tarball)} -C ${extractDir}`
    const packageRoot = join(extractDir, 'package')
    if (!existsSync(packageRoot)) throw new Error(`Unable to extract ${packageName}`)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(packageRoot, destination, { recursive: true, dereference: true })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function stageBun(
  config: BuildConfig,
  bunSource?: string,
): Promise<void> {
  if (!bunSource) {
    await downloadBun(config)
    return
  }

  if (!existsSync(bunSource)) {
    throw new Error(`Bun fixture/source does not exist: ${bunSource}`)
  }
  const binaryName = config.platform === 'win32' ? 'bun.exe' : 'bun'
  const destination = join(config.electronDir, 'vendor', 'bun', binaryName)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(bunSource, destination)
  if (config.platform !== 'win32') chmodSync(destination, 0o755)
}

export async function preparePlatformRuntime(
  options: PreparePlatformRuntimeOptions,
): Promise<void> {
  const config: BuildConfig = {
    platform: options.platform,
    arch: options.arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: resolve(options.rootDir),
    electronDir: resolve(options.electronDir),
  }

  await ensureSdkBinaryPackage(options)
  await stageBun(config, options.bunSource)
  copySDK(config)
  verifySDKCopy(config)
  copyRipgrep(config)
  copyInterceptor(config)

  const bunName = options.platform === 'win32' ? 'bun.exe' : 'bun'
  const required = [
    join(config.electronDir, 'vendor', 'bun', bunName),
    join(config.electronDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
    join(config.electronDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary'),
    join(config.electronDir, 'node_modules', '@vscode', 'ripgrep'),
    join(config.electronDir, 'packages', 'shared', 'src', 'unified-network-interceptor.ts'),
  ]
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`Platform runtime preparation missed ${path}`)
  }
}

export function stagePlatformRuntimeHelpers(
  options: Omit<PreparePlatformRuntimeOptions, 'bunSource'>,
): void {
  const config: BuildConfig = {
    platform: options.platform,
    arch: options.arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: resolve(options.rootDir),
    electronDir: resolve(options.electronDir),
  }
  const sessionOutput = join(config.rootDir, 'packages', 'session-mcp-server', 'dist', 'index.js')
  const piOutput = join(config.rootDir, 'packages', 'pi-agent-server', 'dist', 'index.js')
  if (!existsSync(sessionOutput) || !existsSync(piOutput)) {
    buildMcpServers(config)
  }
  copySessionServer(config)
  copyPiAgentServer(config)
  for (const path of [
    join(config.electronDir, 'resources', 'session-mcp-server', 'index.js'),
    join(config.electronDir, 'resources', 'pi-agent-server', 'index.js'),
  ]) {
    if (!existsSync(path)) throw new Error(`Platform helper staging missed ${path}`)
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string' },
      arch: { type: 'string', default: process.arch === 'arm64' ? 'arm64' : 'x64' },
      'root-dir': { type: 'string', default: resolve(import.meta.dir, '..') },
      'electron-dir': {
        type: 'string',
        default: resolve(import.meta.dir, '..', 'apps', 'electron'),
      },
      'helpers-only': { type: 'boolean', default: false },
    },
    strict: true,
  })
  const platform = (values.platform ?? process.platform) as Platform
  const arch = values.arch as Arch
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    throw new Error(`Unsupported platform: ${platform}`)
  }
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported architecture: ${arch}`)
  }
  const options = {
    platform,
    arch,
    rootDir: values['root-dir']!,
    electronDir: values['electron-dir']!,
  }
  if (values['helpers-only']) {
    stagePlatformRuntimeHelpers(options)
    console.log(`Platform helper servers staged: ${platform}-${arch}`)
  } else {
    await preparePlatformRuntime(options)
    console.log(`Platform runtime ready: ${platform}-${arch}`)
  }
}
