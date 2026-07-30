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
  stagePlatformRuntimeHelpers,
} from '../prepare-platform-runtime'

const roots: string[] = []

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

    expect(existsSync(join(electronDir, 'vendor'))).toBe(false)
    await preparePlatformRuntime({
      platform: 'darwin',
      arch: 'x64',
      rootDir: root,
      electronDir,
      bunSource: bunFixture,
    })
    stagePlatformRuntimeHelpers({
      platform: 'darwin',
      arch: 'x64',
      rootDir: root,
      electronDir,
    })

    for (const path of [
      join(electronDir, 'vendor', 'bun', 'bun'),
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
})
