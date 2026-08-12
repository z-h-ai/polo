import { describe, expect, test } from 'bun:test'
import {
  AccountIdSchema,
  ArtifactInstanceIdSchema,
  CatalogEntryIdSchema,
  EnterpriseIdSchema,
  ListProductSpacesResponseSchema,
  ProductSpaceCatalogResponseSchema,
  ProductSpaceErrorResponseSchema,
  ProductSpaceExecutionScopeSchema,
  ProductSpaceIdSchema,
  ResolveLaunchResponseSchema,
  StopAllExecutionsResultSchema,
  WorkspaceIdSchema,
  createProductSpaceCatalogKey,
  createProductSpaceRuntimeKey,
  invalidateLegacyOrganizationState,
  parseProductSpaceCatalogResponseForProductSpace,
  type EnterpriseId,
  type ProductSpaceId,
  type WorkspaceId,
} from '../index.ts'
import {
  ProductSpaceCatalogResponseSchema as AdminProductSpaceCatalogResponseSchema,
} from '../../admin/product-spaces.ts'

const productSpaceId = ProductSpaceIdSchema.parse('product-space-a')
const accountId = AccountIdSchema.parse('account-a')
const workspaceId = WorkspaceIdSchema.parse('workspace-a')

function personalSpace() {
  return {
    id: 'product-space-a',
    kind: 'personal' as const,
    name: '我的空间' as const,
    accessMode: 'active' as const,
    payer: { kind: 'account' as const },
  }
}

describe('ProductSpace v1 network contract', () => {
  test('Polo admin boundary reuses the shared schema identity', () => {
    expect(AdminProductSpaceCatalogResponseSchema).toBe(ProductSpaceCatalogResponseSchema)
  })

  test('accepts exactly personal and enterprise summaries', () => {
    expect(ListProductSpacesResponseSchema.safeParse({
      contractVersion: 1,
      personalProductSpaceId: 'product-space-a',
      productSpaces: [
        personalSpace(),
        {
          id: 'product-space-b', kind: 'enterprise', enterpriseId: 'enterprise-b',
          name: 'Example enterprise', role: 'member', accessMode: 'read_only',
          restrictionCode: 'billing_restricted',
          payer: { kind: 'enterprise', enterpriseId: 'enterprise-b' },
        },
      ],
    }).success).toBe(true)

    for (const invalid of [
      { ...personalSpace(), enterpriseId: 'enterprise-a' },
      { ...personalSpace(), kind: 'creator_space' },
      {
        id: 'product-space-b', kind: 'enterprise', name: 'Enterprise',
        role: 'member', accessMode: 'active', payer: { kind: 'enterprise', enterpriseId: 'enterprise-b' },
      },
      {
        id: 'product-space-b', kind: 'enterprise', enterpriseId: 'enterprise-b', name: 'Enterprise',
        role: 'member', accessMode: 'active', restrictionCode: 'billing_restricted',
        payer: { kind: 'enterprise', enterpriseId: 'enterprise-b' },
      },
    ]) {
      expect(ListProductSpacesResponseSchema.safeParse({
        contractVersion: 1, personalProductSpaceId: 'product-space-a', productSpaces: [personalSpace(), invalid],
      }).success).toBe(false)
    }
  })

  test('rejects catalog subject confusion and sensitive delivery fields', () => {
    const assistant = {
      catalogEntryId: 'assistant', name: 'Polo assistant', description: 'Built in',
      availability: 'available', kind: 'built_in_app', builtInAppId: 'polo_assistant',
    }
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1', entries: [assistant],
    }).success).toBe(true)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [{ ...assistant, artifactInstanceId: 'must-not-be-on-built-in' }],
    }).success).toBe(false)

    const launch = {
      contractVersion: 1, productSpaceId: 'product-space-a', catalogEntryId: 'assistant',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      payer: { kind: 'account' }, delivery: { kind: 'built_in' },
    }
    expect(ResolveLaunchResponseSchema.safeParse(launch).success).toBe(true)
    expect(ResolveLaunchResponseSchema.safeParse({ ...launch, delivery: { kind: 'built_in', accessToken: 'secret' } }).success).toBe(false)
    expect(ResolveLaunchResponseSchema.safeParse({ ...launch, delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' } }).success).toBe(false)
  })

  test('fails closed for unknown server errors and wrong ID combinations', () => {
    expect(ProductSpaceErrorResponseSchema.safeParse({
      error: 'creator_space_not_allowed', message: 'no', requestId: 'r', retryable: false,
    }).success).toBe(false)
    expect(ProductSpaceErrorResponseSchema.safeParse({
      error: 'catalog_entry_not_found', message: 'no', requestId: 'r', retryable: false, internalStack: 'secret',
    }).success).toBe(false)
    expect(ResolveLaunchResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogEntryId: 'catalog-a',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-a', versionId: 'version-a', version: '1.0.0' },
      payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' },
      delivery: { kind: 'built_in' },
    }).success).toBe(false)
    expect(() => parseProductSpaceCatalogResponseForProductSpace({
      contractVersion: 1, productSpaceId: 'product-space-b', catalogRevision: 'r1', entries: [],
    }, ProductSpaceIdSchema.parse('product-space-a'))).toThrow('did not match')
  })
})

describe('ProductSpace runtime isolation', () => {
  test('retains independent ProductSpace and Workspace IDs in a scope and key', () => {
    const scope = ProductSpaceExecutionScopeSchema.parse({
      contractVersion: 1, executionId: 'execution-a', accountId: 'account-a',
      productSpaceId: 'product-space-a', workspaceId: 'workspace-a',
      subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-a', versionId: 'version-a', version: '1.0.0' },
    })
    expect(scope.productSpaceId).not.toBe(scope.workspaceId)
    expect(createProductSpaceRuntimeKey(scope)).toBe(JSON.stringify([
      'product-space-runtime', 1, 'account-a', 'product-space-a', 'workspace-a', 'execution-a',
    ]))
    expect(createProductSpaceCatalogKey(accountId, productSpaceId)).not.toContain('workspace-a')
    expect(StopAllExecutionsResultSchema.safeParse({
      allStopped: false,
      executions: [{ executionId: 'execution-a', scope, name: 'App', status: 'stopping' }],
    }).success).toBe(true)
    expect(StopAllExecutionsResultSchema.safeParse({
      allStopped: true,
      executions: [{ executionId: 'execution-a', scope, name: 'App', status: 'stopping' }],
    }).success).toBe(false)
  })

  test('keeps opaque IDs non-interchangeable at compile time', () => {
    const product: ProductSpaceId = ProductSpaceIdSchema.parse('product')
    const workspace: WorkspaceId = WorkspaceIdSchema.parse('workspace')
    const enterprise: EnterpriseId = EnterpriseIdSchema.parse('enterprise')
    // @ts-expect-error ProductSpaceId is not a WorkspaceId.
    const wrongWorkspace: WorkspaceId = product
    // @ts-expect-error WorkspaceId is not an EnterpriseId.
    const wrongEnterprise: EnterpriseId = workspace
    expect([wrongWorkspace, wrongEnterprise, product, workspace, enterprise]).toHaveLength(5)
  })
})

test('direct switch cleanup has no Workspace or export deletion capability', async () => {
  const calls: string[] = []
  await invalidateLegacyOrganizationState({
    removeLegacyOrganizationAuthorizationCache: () => { calls.push('authorization') },
    removeLegacyOrganizationCatalogCache: () => { calls.push('catalog') },
    removeLegacyOrganizationRuntimeCache: () => { calls.push('runtime') },
    removeLegacyOrganizationSkillEnablementCache: () => { calls.push('skill-enablement') },
    removeLegacyOrganizationSessionIndex: () => { calls.push('session-index') },
  })
  expect(calls).toEqual(['authorization', 'catalog', 'runtime', 'skill-enablement', 'session-index'])
})

test('contract IDs are parsed before boundary use', () => {
  expect(ArtifactInstanceIdSchema.safeParse('  ').success).toBe(false)
  expect(CatalogEntryIdSchema.safeParse('').success).toBe(false)
  expect(WorkspaceIdSchema.safeParse('workspace').success).toBe(true)
})
