import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Platform } from '../build/common'
import { validateLegacyElectronLayout } from '../validate-legacy-electron-layout'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function legacyFixture(platform: Platform): string {
  const root = mkdtempSync(join(tmpdir(), `polo legacy ${platform} 空格 `))
  roots.push(root)
  const appRoot = join(root, 'resources', 'app')
  const wrapper = join(
    appRoot,
    'resources',
    'bin',
    platform === 'win32' ? 'polo-ai.cmd' : 'polo-ai',
  )
  mkdirSync(dirname(wrapper), { recursive: true })
  mkdirSync(join(appRoot, 'dist'), { recursive: true })
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({
    name: '@polo-ai/electron',
    version: '0.9.7',
    main: 'dist/main.cjs',
    private: true,
    dependencies: { '@polo-ai/shared': 'workspace:*' },
  }))
  writeFileSync(join(appRoot, 'dist', 'main.cjs'), 'legacy electron entry')
  writeFileSync(wrapper, platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
  return appRoot
}

describe('legacy Electron artifact layout', () => {
  it('accepts real pre-POO-14 package metadata without new CLI artifacts on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(validateLegacyElectronLayout(legacyFixture(platform), platform)).toBe('0.9.7')
    }
  })

  it('rejects a current artifact disguised as the previous release', () => {
    const appRoot = legacyFixture('darwin')
    const manifest = join(appRoot, 'dist', 'cli', 'artifact-manifest.json')
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(manifest, '{}')
    expect(() => validateLegacyElectronLayout(appRoot, 'darwin')).toThrow(
      'current POO-14 manifest',
    )
  })
})
