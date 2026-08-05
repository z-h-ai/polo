#!/usr/bin/env bun

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  preparePlatformRuntime,
  stagePlatformRuntimeHelpers,
  type PreparePlatformRuntimeOptions,
} from './prepare-platform-runtime'
import type { Arch, Platform } from './build/common'

export interface ElectronDistOptions {
  platform: Platform
  arch: Arch
  dev: boolean
  rootDir: string
  electronDir: string
}

interface ElectronDistDependencies {
  prepareRuntime: (options: PreparePlatformRuntimeOptions) => Promise<void>
  build: (options: ElectronDistOptions, env: Record<string, string>) => Promise<void>
  stageHelpers: (
    options: Omit<PreparePlatformRuntimeOptions, 'bunSource' | 'uvSource'>,
  ) => void
  package: (options: ElectronDistOptions, env: Record<string, string>) => Promise<void>
}

function inheritedEnvironment(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

async function runCommand(
  command: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const processHandle = Bun.spawn(command, {
    cwd,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await processHandle.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(' ')}`)
  }
}

const defaultDependencies: ElectronDistDependencies = {
  prepareRuntime: preparePlatformRuntime,
  async build(options, env) {
    await runCommand([process.execPath, 'run', 'electron:build'], options.rootDir, env)
  },
  stageHelpers: stagePlatformRuntimeHelpers,
  async package(options, env) {
    const targetFlag = {
      darwin: '--mac',
      win32: '--win',
      linux: '--linux',
    }[options.platform]
    await runCommand(
      [
        process.execPath,
        'x',
        'electron-builder',
        '--config',
        'electron-builder.yml',
        targetFlag,
        `--${options.arch}`,
        ...(options.platform === 'darwin' && options.dev
          ? ['--config.mac.notarize=false']
          : []),
      ],
      options.electronDir,
      env,
    )
  },
}

export async function runElectronDist(
  options: ElectronDistOptions,
  dependencies: ElectronDistDependencies = defaultDependencies,
): Promise<void> {
  if (options.platform !== process.platform) {
    throw new Error(
      `Electron release packaging must run on its native platform: `
      + `target=${options.platform}, host=${process.platform}`,
    )
  }

  const runtimeOptions = {
    platform: options.platform,
    arch: options.arch,
    rootDir: options.rootDir,
    electronDir: options.electronDir,
  }
  const env = inheritedEnvironment({
    POLO_AI_REQUIRE_BUNDLED_RUNTIME: '1',
    POLO_AI_TARGET_PLATFORM: options.platform,
    POLO_AI_TARGET_ARCH: options.arch,
    ...(options.dev ? { POLO_AI_DEV_RUNTIME: '1' } : {}),
  })

  await dependencies.prepareRuntime(runtimeOptions)
  await dependencies.build(options, env)
  dependencies.stageHelpers(runtimeOptions)
  await dependencies.package(options, env)
}

if (import.meta.main) {
  const rootDir = resolve(import.meta.dir, '..')
  const { values } = parseArgs({
    options: {
      platform: { type: 'string', default: process.platform },
      arch: {
        type: 'string',
        default: process.arch === 'arm64' ? 'arm64' : 'x64',
      },
      dev: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (!['darwin', 'win32', 'linux'].includes(values.platform!)) {
    throw new Error(`Unsupported Electron release platform: ${values.platform}`)
  }
  if (!['x64', 'arm64'].includes(values.arch!)) {
    throw new Error(`Unsupported Electron release architecture: ${values.arch}`)
  }

  const options: ElectronDistOptions = {
    platform: values.platform as Platform,
    arch: values.arch as Arch,
    dev: values.dev!,
    rootDir,
    electronDir: resolve(rootDir, 'apps', 'electron'),
  }
  console.log(`Preparing Electron release target ${options.platform}-${options.arch}`)
  await runElectronDist(options)
}
