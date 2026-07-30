import { describe, expect, it } from 'bun:test'
import {
  AppCatalogResponseSchema,
  isValidMainlandChinaPhone,
  MainlandChinaPhoneSchema,
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
