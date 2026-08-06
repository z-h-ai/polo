#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Platform } from './build/common'

export function validateLegacyElectronLayout(
  appRootInput: string,
  platform: Platform,
): string {
  const appRoot = resolve(appRootInput)
  const packagePath = join(appRoot, 'package.json')
  if (!existsSync(packagePath)) {
    throw new Error(`Legacy Electron package metadata is missing: ${packagePath}`)
  }
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    name?: string
    version?: string
    main?: string
  }
  if (
    metadata.name !== '@polo-ai/electron'
    || metadata.main !== 'dist/main.cjs'
    || typeof metadata.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version)
  ) {
    throw new Error('Unsupported legacy Electron package metadata')
  }

  const wrapper = join(
    appRoot,
    'resources',
    'bin',
    platform === 'win32' ? 'polo-ai.cmd' : 'polo-ai',
  )
  for (const required of [join(appRoot, 'dist', 'main.cjs'), wrapper]) {
    if (!existsSync(required)) {
      throw new Error(`Unsupported pre-POO-14 Electron layout: ${required}`)
    }
  }
  if (existsSync(join(appRoot, 'dist', 'cli', 'artifact-manifest.json'))) {
    throw new Error('Legacy artifact unexpectedly contains the current POO-14 manifest')
  }
  return metadata.version
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'app-root': { type: 'string' },
      platform: { type: 'string' },
    },
    strict: true,
  })
  const platform = values.platform as Platform | undefined
  if (!values['app-root'] || !platform || !['darwin', 'linux', 'win32'].includes(platform)) {
    throw new Error('Usage: validate-legacy-electron-layout.ts --app-root <path> --platform <target>')
  }
  process.stdout.write(validateLegacyElectronLayout(values['app-root'], platform))
}
