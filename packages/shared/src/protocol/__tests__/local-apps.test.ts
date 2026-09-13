import { describe, expect, it } from 'bun:test'
import {
  isProductSpaceRuntimeRequest,
  projectLocalAppStatusForCatalogAccess,
  type LocalAppInstalledApp,
  type LocalAppRuntimeStatus,
  type ProductSpaceAppRuntimeStartResult,
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

describe('localApps ProductSpace runtime request union (POO-54)', () => {
  const identity = {
    accountId: 'account-1',
    productSpaceId: 'space-1',
    catalogEntryId: 'entry-1',
    artifactInstanceId: 'artifact-1',
    versionId: 'version-1',
    version: '1.0.0',
    catalogRevision: 'rev-1',
    sources: [{ kind: 'enterprise_import', name: null, circleId: null }],
    availability: 'available' as const,
  }

  it('discriminates ProductSpace runtime requests from legacy scopes', () => {
    expect(isProductSpaceRuntimeRequest({
      kind: 'product_space_runtime_start',
      app: identity,
    })).toBe(true)
    expect(isProductSpaceRuntimeRequest({
      kind: 'product_space_runtime_handle',
      executionId: 'local-app:space-1:artifact-1:1',
      expectedRuntimeGeneration: 3,
    })).toBe(true)
    // The legacy scope-only branch can never be mistaken for a ProductSpace
    // runtime request.
    expect(isProductSpaceRuntimeRequest({
      kind: 'catalog',
      accountId: 'account-1',
      organizationId: 'space-1',
      catalogAppId: 'artifact-1',
    })).toBe(false)
    expect(isProductSpaceRuntimeRequest(null)).toBe(false)
    expect(isProductSpaceRuntimeRequest({ kind: 'legacy' })).toBe(false)
  })

  it('keeps the runtime start result free of capability and gateway URL secrets', () => {
    const result: ProductSpaceAppRuntimeStartResult = {
      appId: 'artifact-1',
      version: '1.0.0',
      executionId: 'local-app:space-1:artifact-1:1',
      runtimeGeneration: 4,
      scopeGeneration: 2,
      runtimeKind: 'python',
      platformApi: { status: 'available' },
    }
    expect(JSON.stringify(result)).not.toContain('POLO_APP_API_TOKEN')
    expect(JSON.stringify(result)).not.toContain('127.0.0.1')
    const staticResult: ProductSpaceAppRuntimeStartResult = {
      ...result,
      runtimeKind: 'static',
      platformApi: { status: 'unavailable', reason: 'static_runtime_unsupported' },
    }
    expect(staticResult.platformApi).toEqual({
      status: 'unavailable',
      reason: 'static_runtime_unsupported',
    })
  })
})
