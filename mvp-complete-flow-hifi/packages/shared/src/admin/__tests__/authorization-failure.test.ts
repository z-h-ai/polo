import { describe, expect, it } from 'bun:test'
import {
  classifyAdminAuthorizationFailure,
  markAppCatalogAccessDenied,
} from '../authorization-failure.ts'
import { DeniedAppCatalogSnapshotSchema } from '../schemas.ts'

describe('Admin authorization failure classification', () => {
  it('gives HTTP 401 priority over every Catalog body code', () => {
    for (const errorCode of [
      'FORBIDDEN',
      'MEMBERSHIP_REMOVED',
      'unknown_body_error',
    ]) {
      expect(classifyAdminAuthorizationFailure(
        { errorCode, status: 401 },
        { catalogScoped: true },
      )).toBe('session')
    }
  })

  it('separates Catalog scope loss from account session loss', () => {
    for (const errorCode of [
      'FORBIDDEN',
      'MEMBERSHIP_REMOVED',
      'MEMBERSHIP_SUSPENDED',
      'ORGANIZATION_UNAVAILABLE',
      'NOT_FOUND',
    ]) {
      expect(classifyAdminAuthorizationFailure(
        { errorCode, status: errorCode === 'FORBIDDEN' ? 403 : undefined },
        { catalogScoped: true },
      )).toBe('catalog_scope')
    }
    expect(classifyAdminAuthorizationFailure(
      { errorCode: 'ACCOUNT_DISABLED', status: 403 },
      { catalogScoped: true },
    )).toBe('session')
  })

  it('keeps non-Catalog organization RPC authorization failures fail closed', () => {
    for (const value of [
      { errorCode: 'FORBIDDEN', status: 403 },
      { errorCode: 'MEMBERSHIP_REMOVED' },
      { errorCode: 'unknown_body_error', status: 401 },
    ]) {
      expect(classifyAdminAuthorizationFailure(
        value,
        { catalogScoped: false },
      )).toBe('session')
    }
  })

  it('creates a sanitized denied Catalog snapshot without mutating the input', () => {
    const catalog = {
      accountId: 'account-a',
      organizationId: 'organization-a',
      appConfigVersion: 'v1',
      authorizationStatus: 'authorized' as const,
      syncedAt: 1,
      apps: [{
        id: 'visible-app',
        organizationId: 'organization-a',
        name: 'Visible',
        description: '',
        deliveryMode: 'remote_url' as const,
        remoteUrl: 'https://example.com',
        sortOrder: 0,
        availability: 'available' as const,
      }],
      withdrawnApps: [{
        id: 'retained-app',
        organizationId: 'organization-a',
        name: 'Retained',
        description: '',
        deliveryMode: 'local_bundle' as const,
        currentRelease: {
          version: '1.0.0',
          runtime: 'static' as const,
          downloadUrl: 'https://private.example.com/bundle.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 42,
        },
        permissions: ['filesystem'],
        sortOrder: 1,
        availability: 'withdrawn' as const,
      }],
      trustedReleases: {
        'retained-app': {
          version: '1.0.0',
          runtime: 'static' as const,
          downloadUrl: 'https://private.example.com/bundle.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 42,
        },
      },
    }

    const denied = markAppCatalogAccessDenied(catalog)
    expect(denied).toMatchObject({
      authorizationStatus: 'denied',
      apps: [{ availability: 'unavailable' }],
      withdrawnApps: [{ availability: 'unavailable' }],
    })
    expect(DeniedAppCatalogSnapshotSchema.safeParse(denied).success).toBe(true)
    expect(denied).not.toHaveProperty('trustedReleases')
    expect(denied).not.toHaveProperty('warnings')
    expect(denied.apps[0]).not.toHaveProperty('remoteUrl')
    expect(denied.withdrawnApps?.[0]).not.toHaveProperty('currentRelease')
    expect(denied.withdrawnApps?.[0]).not.toHaveProperty('permissions')
    expect(catalog).toMatchObject({
      authorizationStatus: 'authorized',
      apps: [{
        availability: 'available',
        remoteUrl: 'https://example.com',
      }],
      withdrawnApps: [{
        availability: 'withdrawn',
        currentRelease: {
          downloadUrl: 'https://private.example.com/bundle.zip',
        },
      }],
      trustedReleases: {
        'retained-app': {
          checksum: 'a'.repeat(64),
        },
      },
    })
  })
})
