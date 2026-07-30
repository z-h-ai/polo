import { describe, expect, it } from 'bun:test'
import {
  projectLocalAppStatusForCatalogAccess,
  type LocalAppInstalledApp,
  type LocalAppRuntimeStatus,
} from '../local-apps'

describe('projectLocalAppStatusForCatalogAccess', () => {
  const privateRelease = {
    version: '2.0.0',
    downloadUrl: 'https://private.example.com/app.zip',
    checksum: 'a'.repeat(64),
    sizeBytes: 42,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
  }

  it('removes delivery metadata from runtime and installed status projections', () => {
    const runtimeStatus: LocalAppRuntimeStatus = {
      appId: 'app-1',
      status: 'update_available',
      currentVersion: '1.0.0',
      availableRelease: privateRelease,
    }
    const installedApp: LocalAppInstalledApp = {
      appId: 'app-1',
      currentVersion: '1.0.0',
      versions: ['1.0.0'],
      runtime: 'static',
      status: 'update_available',
      installedAt: 1,
      availableRelease: privateRelease,
    }

    expect(projectLocalAppStatusForCatalogAccess(runtimeStatus, false))
      .not.toHaveProperty('availableRelease')
    expect(projectLocalAppStatusForCatalogAccess(installedApp, false))
      .not.toHaveProperty('availableRelease')
  })

  it('preserves authorized delivery metadata without cloning the status', () => {
    const status: LocalAppRuntimeStatus = {
      appId: 'app-1',
      status: 'update_available',
      availableRelease: privateRelease,
    }

    expect(projectLocalAppStatusForCatalogAccess(status, true)).toBe(status)
  })
})
