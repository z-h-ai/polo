#!/usr/bin/env bun

import { $ } from 'bun'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  buildPiAgentServer,
  copyInterceptor,
  copyPiAgentServer,
  copyRipgrep,
  copySDK,
  downloadBun,
  downloadUv,
  getPlatformKey,
  isPinnedUvVersionOutput,
  validateUvRuntimeManifest,
  verifyUvBinaryArchitecture,
  verifySDKCopy,
  writeUvRuntimeManifest,
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
  uvSource?: string
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

type NativePackageInstaller = (name: string, version: string, integrity: string, destination: string) => Promise<void>

const installLockedNativePackage: NativePackageInstaller = async (name, version, integrity, destination) => {
  const staging = mkdtempSync(join(dirname(destination), '.sharp-prepare-'))
  try {
    await $`npm pack ${`${name}@${version}`} --pack-destination ${staging}`.quiet()
    const tarball = readdirSync(staging).find(file => file.endsWith('.tgz'))
    if (!tarball) throw new Error(`Missing native package tarball: ${name}`)
    const archive = join(staging, tarball)
    const actual = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`
    if (actual !== integrity) throw new Error(`Locked native package integrity mismatch: ${name}`)
    await $`tar -xzf ${archive} -C ${staging}`.quiet()
    // Validate before replacing an existing target; an interrupted download
    // cannot destroy a previously prepared architecture.
    const manifest = JSON.parse(readFileSync(join(staging, 'package/package.json'), 'utf8'))
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Native package identity mismatch: ${name}`)
    rmSync(destination, { recursive: true, force: true })
    cpSync(join(staging, 'package'), destination, { recursive: true, dereference: true })
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

/** npm optional dependencies follow the host CPU. Release preparation must
 * explicitly materialize both target native packages using bun.lock integrity. */
export async function prepareMacSharpRuntime(rootDir: string, arch: Arch, install: NativePackageInstaller = installLockedNativePackage): Promise<void> {
  const lock = Bun.JSON5.parse(readFileSync(join(rootDir, 'bun.lock'), 'utf8')) as { packages: Record<string, [string, string, unknown, string]> }
  const sharp = JSON.parse(readFileSync(join(rootDir, 'node_modules/sharp/package.json'), 'utf8'))
  if (lock.packages.sharp?.[0] !== `sharp@${sharp.version}`) throw new Error('Installed sharp does not match bun.lock')
  for (const name of [`@img/sharp-darwin-${arch}`, `@img/sharp-libvips-darwin-${arch}`]) {
    const version = sharp.optionalDependencies?.[name]
    const entry = lock.packages[name]
    if (!version || entry?.[0] !== `${name}@${version}` || !entry[3]?.startsWith('sha512-')) throw new Error(`Missing locked sharp native dependency: ${name}`)
    const destination = join(rootDir, 'node_modules', name)
    const valid = () => {
      try {
        const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'))
        return manifest.name === name && manifest.version === version && manifest.os?.includes('darwin') && manifest.cpu?.includes(arch)
          && (name.includes('libvips') ? existsSync(join(destination, 'lib/index.js')) && readdirSync(join(destination, 'lib')).some(file => /^libvips.*\.dylib$/.test(file)) : existsSync(join(destination, 'lib', `sharp-darwin-${arch}.node`)))
      } catch { return false }
    }
    if (!valid()) {
      mkdirSync(dirname(destination), { recursive: true })
      await install(name, version, entry[3], destination)
    }
    if (!valid()) throw new Error(`Prepared sharp native payload is invalid: ${name}`)
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

export async function stageUvRuntime(
  config: BuildConfig,
  uvSource?: string,
): Promise<string> {
  const binaryName = config.platform === 'win32' ? 'uv.exe' : 'uv'
  const destination = join(
    config.electronDir,
    'resources',
    'bin',
    getPlatformKey(config.platform, config.arch),
    binaryName,
  )
  if (uvSource) {
    if (!existsSync(uvSource)) {
      throw new Error(`uv fixture/source does not exist: ${uvSource}`)
    }
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(uvSource, destination)
    if (config.platform !== 'win32') chmodSync(destination, 0o755)
  } else {
    await downloadUv(config)
  }
  verifyUvBinaryArchitecture(destination, config.platform, config.arch)
  if (uvSource) {
    writeUvRuntimeManifest(config, destination, 'fixture')
  }
  validateUvRuntimeManifest(config, { requireTrusted: !uvSource })

  if (
    !uvSource
    && config.platform === process.platform
    && config.arch === process.arch
  ) {
    const output = execFileSync(destination, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }).trim()
    if (!isPinnedUvVersionOutput(output)) {
      throw new Error(`Unexpected uv version output: ${output}`)
    }
  }
  return destination
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

  // Minimal runtime-only consumers need not depend on sharp. The Electron
  // release root declares sharp and must prepare its target native payload.
  const rootPackage = await Bun.file(join(config.rootDir, 'package.json')).json()
  if (options.platform === 'darwin' && (rootPackage.dependencies?.sharp || rootPackage.optionalDependencies?.[`@img/sharp-darwin-${options.arch}`])) await prepareMacSharpRuntime(config.rootDir, options.arch)
  await ensureSdkBinaryPackage(options)
  await stageBun(config, options.bunSource)
  const uvPath = await stageUvRuntime(config, options.uvSource)
  copySDK(config)
  verifySDKCopy(config)
  copyRipgrep(config)
  copyInterceptor(config)

  const bunName = options.platform === 'win32' ? 'bun.exe' : 'bun'
  const required = [
    join(config.electronDir, 'vendor', 'bun', bunName),
    uvPath,
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
  options: Omit<PreparePlatformRuntimeOptions, 'bunSource' | 'uvSource'>,
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
  const piOutput = join(config.rootDir, 'packages', 'pi-agent-server', 'dist', 'index.js')
  if (!existsSync(piOutput)) {
    buildPiAgentServer(config)
  }
  copyPiAgentServer(config)
  const stagedPiServer = join(config.electronDir, 'resources', 'pi-agent-server', 'index.js')
  if (!existsSync(stagedPiServer)) throw new Error(`Platform helper staging missed ${stagedPiServer}`)
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
