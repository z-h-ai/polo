import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runElectronDist, type ElectronDistOptions } from '../electron-dist'
import type { Arch, Platform } from '../build/common'

describe('target-aware Electron release entry', () => {
  it('keeps macOS notarization enabled except for explicit development smoke', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'electron-dist.ts'), 'utf8')
    const builder = readFileSync(
      join(import.meta.dir, '..', '..', 'apps', 'electron', 'electron-builder.yml'),
      'utf8',
    )
    expect(builder).toContain('notarize: true')
    expect(source).toContain("'--config.mac.notarize=false'")
    expect(source).toContain("options.platform === 'darwin' && options.dev")
  })

  it('always prepares the complete target runtime and finalizes artifacts after packaging', async () => {
    const calls: string[] = []
    const options: ElectronDistOptions = {
      platform: process.platform as Platform,
      arch: (process.arch === 'arm64' ? 'arm64' : 'x64') as Arch,
      dev: false,
      rootDir: '/fixture/root',
      electronDir: '/fixture/root/apps/electron',
    }

    await runElectronDist(options, {
      prepareRuntime: async (runtime) => {
        calls.push(`prepare:${runtime.platform}-${runtime.arch}`)
      },
      build: async (_dist, env) => {
        expect(env.POLO_AI_REQUIRE_BUNDLED_RUNTIME).toBe('1')
        expect(env.POLO_AI_TARGET_PLATFORM).toBe(options.platform)
        expect(env.POLO_AI_TARGET_ARCH).toBe(options.arch)
        expect(env.POLO_AI_DEV_RUNTIME).toBeUndefined()
        calls.push('build')
      },
      stageHelpers: () => {
        calls.push('helpers')
      },
      package: async () => {
        calls.push('package')
      },
      finalizeArtifacts: async () => {
        calls.push('finalize')
      },
    })

    expect(calls).toEqual([
      `prepare:${options.platform}-${options.arch}`,
      'build',
      'helpers',
      'package',
      'finalize',
    ])
  })

  it('refuses a non-native release target before mutating runtime state', async () => {
    const foreignPlatform = process.platform === 'darwin' ? 'linux' : 'darwin'
    let prepared = false

    await expect(runElectronDist({
      platform: foreignPlatform,
      arch: 'x64',
      dev: false,
      rootDir: '/fixture/root',
      electronDir: '/fixture/root/apps/electron',
    }, {
      prepareRuntime: async () => {
        prepared = true
      },
      build: async () => {},
      stageHelpers: () => {},
      package: async () => {},
      finalizeArtifacts: async () => {},
    })).rejects.toThrow('must run on its native platform')
    expect(prepared).toBe(false)
  })
})
