import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  preparePlatformRuntime,
  stageUvRuntime,
  stagePlatformRuntimeHelpers,
} from '../prepare-platform-runtime'
import type { Arch, BuildConfig, Platform } from '../build/common'

const roots: string[] = []

function writeUvFixture(path: string, platform: Platform, arch: Arch): void {
  const bytes = Buffer.alloc(256)
  if (platform === 'darwin') {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  } else if (platform === 'linux') {
    bytes[0] = 0x7f
    bytes.write('ELF', 1, 'ascii')
    bytes[5] = 1
    bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
  } else {
    bytes.write('MZ', 0, 'ascii')
    bytes.writeUInt32LE(0x80, 0x3c)
    bytes.write('PE\u0000\u0000', 0x80, 'binary')
    bytes.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 0x84)
  }
  writeFileSync(path, bytes)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('preparePlatformRuntime', () => {
  it('materializes every ignored runtime dependency into a clean Electron tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polo clean runtime 根目录 '))
    roots.push(root)
    const electronDir = join(root, 'apps', 'electron clean')
    const modules = join(root, 'node_modules')
    const sdkScope = join(modules, '@anthropic-ai')
    const sdkCore = join(sdkScope, 'claude-agent-sdk')
    const sdkBinary = join(sdkScope, 'claude-agent-sdk-darwin-x64')
    const ripgrep = join(modules, '@vscode', 'ripgrep')
    const shared = join(root, 'packages', 'shared', 'src')
    const sessionServer = join(root, 'packages', 'session-mcp-server', 'src')
    const piServer = join(root, 'packages', 'pi-agent-server', 'src')
    const koffi = join(modules, 'koffi')
    const bunFixture = join(root, 'fixture bun')
    const uvFixture = join(root, 'fixture uv')

    mkdirSync(sdkCore, { recursive: true })
    mkdirSync(sdkBinary, { recursive: true })
    mkdirSync(join(ripgrep, 'bin'), { recursive: true })
    mkdirSync(shared, { recursive: true })
    mkdirSync(sessionServer, { recursive: true })
    mkdirSync(piServer, { recursive: true })
    mkdirSync(join(koffi, 'lib'), { recursive: true })
    mkdirSync(join(koffi, 'build', 'koffi', 'darwin_x64'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: { '@anthropic-ai/claude-agent-sdk': '0.2.113' },
    }))
    writeFileSync(join(sdkCore, 'sdk.mjs'), 'export {}\n')
    writeFileSync(join(sdkCore, 'package.json'), '{"name":"@anthropic-ai/claude-agent-sdk"}\n')
    writeFileSync(join(sdkBinary, 'package.json'), '{"name":"fixture-sdk-binary"}\n')
    writeFileSync(join(sdkBinary, 'claude'), '')
    truncateSync(join(sdkBinary, 'claude'), 50_000_001)
    writeFileSync(join(ripgrep, 'bin', 'rg'), '#!/bin/sh\n')
    writeFileSync(join(sessionServer, 'index.ts'), 'export const sessionFixture = true\n')
    writeFileSync(join(piServer, 'index.ts'), 'export const piFixture = true\n')
    writeFileSync(join(koffi, 'package.json'), '{"name":"koffi"}\n')
    writeFileSync(join(koffi, 'index.js'), 'module.exports = {}\n')
    writeFileSync(join(koffi, 'indirect.js'), 'module.exports = {}\n')
    writeFileSync(join(koffi, 'index.d.ts'), 'export {}\n')
    writeFileSync(join(koffi, 'build', 'koffi', 'darwin_x64', 'koffi.node'), 'fixture')
    for (const file of [
      'unified-network-interceptor.ts',
      'interceptor-common.ts',
      'feature-flags.ts',
      'interceptor-request-utils.ts',
    ]) {
      writeFileSync(join(shared, file), 'export {}\n')
    }
    writeFileSync(bunFixture, '#!/bin/sh\n')
    writeUvFixture(uvFixture, 'darwin', 'x64')

    expect(existsSync(join(electronDir, 'vendor'))).toBe(false)
    await preparePlatformRuntime({
      platform: 'darwin',
      arch: 'x64',
      rootDir: root,
      electronDir,
      bunSource: bunFixture,
      uvSource: uvFixture,
    })
    stagePlatformRuntimeHelpers({
      platform: 'darwin',
      arch: 'x64',
      rootDir: root,
      electronDir,
    })

    for (const path of [
      join(electronDir, 'vendor', 'bun', 'bun'),
      join(electronDir, 'resources', 'bin', 'darwin-x64', 'uv'),
      join(electronDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
      join(electronDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary', 'claude'),
      join(electronDir, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
      join(electronDir, 'packages', 'shared', 'src', 'unified-network-interceptor.ts'),
      join(electronDir, 'resources', 'session-mcp-server', 'index.js'),
      join(electronDir, 'resources', 'pi-agent-server', 'index.js'),
    ]) {
      expect(existsSync(path)).toBe(true)
    }
  })

  it('stages and architecture-checks uv for every supported target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polo uv runtime targets '))
    roots.push(root)
    const targets: Array<[Platform, Arch]> = [
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['win32', 'x64'],
      ['win32', 'arm64'],
    ]

    for (const [platform, arch] of targets) {
      const electronDir = join(root, `${platform}-${arch}`)
      const fixture = join(root, `fixture-${platform}-${arch}`)
      writeUvFixture(fixture, platform, arch)
      const config: BuildConfig = {
        platform,
        arch,
        upload: false,
        uploadLatest: false,
        uploadScript: false,
        rootDir: root,
        electronDir,
      }
      const staged = await stageUvRuntime(config, fixture)
      expect(existsSync(staged)).toBe(true)
    }
  })

  it('rejects a uv binary for the wrong architecture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polo uv wrong arch '))
    roots.push(root)
    const fixture = join(root, 'uv')
    writeUvFixture(fixture, 'linux', 'arm64')
    await expect(stageUvRuntime({
      platform: 'linux',
      arch: 'x64',
      upload: false,
      uploadLatest: false,
      uploadScript: false,
      rootDir: root,
      electronDir: join(root, 'electron'),
    }, fixture)).rejects.toThrow('architecture mismatch')
  })
})
