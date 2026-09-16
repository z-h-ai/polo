import { describe, expect, it } from 'bun:test'
import {
  AdminEntityIdSchema,
  AdminLoginResponseSchema,
  AppCatalogResponseSchema,
  CatalogOrganizationIdRpcInputSchema,
  DeniedAppCatalogSnapshotSchema,
  isValidMainlandChinaPhone,
  MainlandChinaPhoneSchema,
  OrganizationIdRpcInputSchema,
  SendPhoneAuthCodeRpcInputSchema,
  VerifyPhoneAuthCodeRpcInputSchema,
} from '../schemas'

function catalogApp(
  deliveryMode: 'remote_url' | 'local_bundle',
  id = 'catalog-app',
) {
  return {
    id,
    organizationId: 'organization-a',
    name: 'Catalog App',
    description: '',
    deliveryMode,
    ...(deliveryMode === 'remote_url'
      ? { remoteUrl: 'https://catalog.example/app' }
      : {
          currentRelease: {
            version: '1.0.0',
            runtime: 'static' as const,
            downloadUrl: 'https://catalog.example/app.zip',
            checksum: 'a'.repeat(64),
            sizeBytes: 1,
          },
        }),
    sortOrder: 0,
  }
}

describe('mainland China phone validation parity', () => {
  it('accepts only the shared 13-19 mobile prefix and eleven-digit length', () => {
    for (const phone of ['13000000000', '13800138000', '19999999999']) {
      expect(isValidMainlandChinaPhone(phone)).toBe(true)
      expect(MainlandChinaPhoneSchema.safeParse(phone).success).toBe(true)
      expect(SendPhoneAuthCodeRpcInputSchema.safeParse({
        phone,
        challengeToken: 'signed-challenge',
      }).success).toBe(true)
      expect(VerifyPhoneAuthCodeRpcInputSchema.safeParse({
        phone,
        code: '123456',
      }).success).toBe(true)
    }
  })

  it('rejects 12-prefix, short, overlong, and non-digit-prefix values everywhere', () => {
    for (const phone of [
      '12000000000',
      '1380013800',
      '138001380000',
      'a3800138000',
    ]) {
      expect(isValidMainlandChinaPhone(phone)).toBe(false)
      expect(MainlandChinaPhoneSchema.safeParse(phone).success).toBe(false)
      expect(SendPhoneAuthCodeRpcInputSchema.safeParse({
        phone,
        challengeToken: 'signed-challenge',
      }).success).toBe(false)
      expect(VerifyPhoneAuthCodeRpcInputSchema.safeParse({
        phone,
        code: '123456',
      }).success).toBe(false)
    }
  })
})

describe('AppCatalogResponseSchema identity constraints', () => {
  for (const deliveryMode of ['remote_url', 'local_bundle'] as const) {
    it(`rejects duplicate ${deliveryMode} app ids`, () => {
      const duplicate = catalogApp(deliveryMode)
      const result = AppCatalogResponseSchema.safeParse({
        appConfigVersion: 'catalog-v1',
        apps: [
          duplicate,
          {
            ...duplicate,
            ...(deliveryMode === 'remote_url'
              ? { remoteUrl: 'https://catalog.example/other' }
              : {
                  currentRelease: {
                    version: '1.0.1',
                    runtime: 'static' as const,
                    downloadUrl: 'https://catalog.example/other.zip',
                    checksum: 'b'.repeat(64),
                    sizeBytes: 2,
                  },
                }),
            sortOrder: 1,
          },
        ],
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({
          path: ['apps', 1, 'id'],
          message: 'Catalog app ids must be unique',
        }))
      }
    })
  }
})

describe('Catalog organization entity id RPC contract', () => {
  it('accepts colon, Unicode, and 512-character ids without widening UUID-only writes', () => {
    const entityIds = [
      'tenant:creator-space',
      '组织：研发圈',
      '组织\0研发圈',
      `org:${'x'.repeat(508)}`,
    ]
    for (const organizationId of entityIds) {
      expect(organizationId.length).toBeLessThanOrEqual(512)
      expect(CatalogOrganizationIdRpcInputSchema.safeParse(organizationId).success)
        .toBe(true)
    }
    expect(CatalogOrganizationIdRpcInputSchema.safeParse(' '.repeat(32)).success)
      .toBe(false)
    expect(CatalogOrganizationIdRpcInputSchema.safeParse('x'.repeat(513)).success)
      .toBe(false)

    expect(OrganizationIdRpcInputSchema.safeParse('tenant:creator-space').success)
      .toBe(false)
    expect(OrganizationIdRpcInputSchema.safeParse(
      '11111111-1111-4111-8111-111111111111',
    ).success).toBe(true)
  })

  it('accepts valid surrogate pairs and rejects unpaired UTF-16 surrogates', () => {
    for (const entityId of ['account-🚀', '\uD83D\uDE80']) {
      expect(AdminEntityIdSchema.safeParse(entityId).success).toBe(true)
      expect(CatalogOrganizationIdRpcInputSchema.safeParse(entityId).success)
        .toBe(true)
    }
    for (const entityId of [
      '\uD800',
      '\uDC00',
      `prefix-\uD800`,
      `prefix-\uDC00-suffix`,
      '\uD800x\uDC00',
    ]) {
      expect(AdminEntityIdSchema.safeParse(entityId).success).toBe(false)
      expect(CatalogOrganizationIdRpcInputSchema.safeParse(entityId).success)
        .toBe(false)
    }
    expect(AdminLoginResponseSchema.safeParse({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      user: {
        id: '\uD800',
        username: 'malformed-account',
        displayName: null,
        role: 'member',
        groupIds: [],
      },
    }).success).toBe(false)
  })

  it('strictly rejects delivery capability fields in denied snapshots', () => {
    const deniedApp = {
      id: 'remote-app',
      organizationId: '组织：研发圈',
      name: 'Remote',
      description: '',
      deliveryMode: 'remote_url',
      sortOrder: 0,
      availability: 'unavailable',
    }
    expect(DeniedAppCatalogSnapshotSchema.safeParse({
      accountId: 'account-a',
      organizationId: deniedApp.organizationId,
      appConfigVersion: 'v1',
      authorizationStatus: 'denied',
      syncedAt: 1,
      apps: [deniedApp],
    }).success).toBe(true)
    for (const capability of [
      { remoteUrl: 'https://private.example.com' },
      {
        currentRelease: {
          version: '1.0.0',
          runtime: 'static',
          downloadUrl: 'https://private.example.com/bundle.zip',
          checksum: 'a'.repeat(64),
          sizeBytes: 1,
        },
      },
      { permissions: ['filesystem'] },
    ]) {
      expect(DeniedAppCatalogSnapshotSchema.safeParse({
        accountId: 'account-a',
        organizationId: deniedApp.organizationId,
        appConfigVersion: 'v1',
        authorizationStatus: 'denied',
        syncedAt: 1,
        apps: [{ ...deniedApp, ...capability }],
      }).success).toBe(false)
    }
  })
})
