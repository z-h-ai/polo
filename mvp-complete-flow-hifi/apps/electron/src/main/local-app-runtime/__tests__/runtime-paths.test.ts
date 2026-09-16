import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { resolveBundledBunPath } from '../runtime-paths'

describe('resolveBundledBunPath', () => {
  const resourcesPath = join('/opt', 'Polo AI', 'resources')
  const appResourcesBase = join(resourcesPath, 'app')

  it.each([
    ['darwin', join(resourcesPath, 'vendor/bun/bun')],
    ['linux', join(resourcesPath, 'vendor/bun/bun')],
    ['win32', join(resourcesPath, 'vendor/bun/bun.exe')],
  ] as const)('matches the packaged %s electron-builder layout', (platform, expected) => {
    expect(resolveBundledBunPath({
      isPackaged: true,
      platform,
      resourcesPath,
      appResourcesBase,
    })).toBe(expected)
  })

  it('uses the development app resources tree on Windows', () => {
    expect(resolveBundledBunPath({
      isPackaged: false,
      platform: 'win32',
      resourcesPath,
      appResourcesBase: join('/repo', 'apps/electron'),
    })).toBe(join('/repo', 'apps/electron/vendor/bun/bun.exe'))
  })
})
