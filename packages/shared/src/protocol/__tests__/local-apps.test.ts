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

  it('strictly allowlists denied runtime and installed status projections', () => {
    const runtimeStatus: LocalAppRuntimeStatus = {
      appId: 'app-1',
      scope: {
        kind: 'catalog',
        accountId: 'account-1',
        organizationId: 'organization-1',
        catalogAppId: 'app-1',
      },
      status: 'running',
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
      previousVersion: '0.9.0',
      url: 'http://127.0.0.1:9876',
      port: 9876,
      pid: 1234,
      installationStatus: 'downloading',
      progress: {
        phase: 'downloading',
        bytesDownloaded: 10,
        sizeBytes: 20,
        percent: 50,
      },
      availableRelease: privateRelease,
      versionError: 'invalid_semver',
      error: {
        code: 'START_FAILED',
        message: 'Start failed',
        details: {
          url: 'http://127.0.0.1:9876',
          pid: 1234,
          secret: 'private',
        },
      },
    }
    const installedApp: LocalAppInstalledApp = {
      appId: 'app-1',
      scope: runtimeStatus.scope,
      name: 'Private App',
      currentVersion: '1.0.0',
      previousVersion: '0.9.0',
      versions: ['1.0.0'],
      runtime: 'static',
      status: 'update_available',
      installedAt: 1,
      availableRelease: privateRelease,
    }

    expect(projectLocalAppStatusForCatalogAccess(runtimeStatus, false))
      .toEqual({
        appId: 'app-1',
        scope: runtimeStatus.scope,
        status: 'running',
        currentVersion: '1.0.0',
        runningVersion: '1.0.0',
        previousVersion: '0.9.0',
        versionError: 'invalid_semver',
        error: {
          code: 'START_FAILED',
          message: 'Start failed',
        },
      })
    expect(projectLocalAppStatusForCatalogAccess(installedApp, false))
      .toEqual({
        appId: 'app-1',
        scope: runtimeStatus.scope,
        currentVersion: '1.0.0',
        status: 'update_available',
      })
  })

  it('projects denied status even when no release metadata is present', () => {
    const status: LocalAppRuntimeStatus = {
      appId: 'app-1',
      status: 'running',
      url: 'http://127.0.0.1:1234',
      port: 1234,
      pid: 5678,
    }

    expect(projectLocalAppStatusForCatalogAccess(status, false)).toEqual({
      appId: 'app-1',
      status: 'running',
    })
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
