import { describe, expect, test } from 'bun:test'
import {
  AccountIdSchema,
  ArtifactInstanceIdSchema,
  CatalogEntryIdSchema,
  EnterpriseIdSchema,
  ListProductSpacesResponseSchema,
  ProductSpaceCatalogResponseSchema,
  ProductSpaceCatalogEntrySchema,
  ProductSpaceErrorResponseSchema,
  ProductSpaceExecutionScopeSchema,
  ProductSpaceIdSchema,
  ProductSpaceRefSchema,
  ProductSpaceSummarySchema,
  ResolveLaunchResponseSchema,
  StopAllExecutionsResultSchema,
  WorkspaceIdSchema,
  createProductSpaceCatalogKey,
  createProductSpaceRuntimeKey,
  invalidateLegacyOrganizationState,
  parseProductSpaceCatalogResponseForProductSpace,
  parseActiveExecutionsForProductSpace,
  parseResolveLaunchResponseForProductSpace,
  parseStopAllExecutionsResultForProductSpace,
  parseUpdateSkillEnablementResponseForProductSpace,
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

function enterpriseSpace(accessMode: 'active' | 'read_only' = 'active') {
  return {
    id: 'product-space-a', kind: 'enterprise' as const, enterpriseId: 'enterprise-a',
    name: 'Example enterprise', role: 'member' as const, accessMode,
    ...(accessMode === 'read_only' ? { restrictionCode: 'billing_restricted' as const } : {}),
    payer: { kind: 'enterprise' as const, enterpriseId: 'enterprise-a' },
  }
}

function catalogApp(sources: unknown[]) {
  return {
    catalogEntryId: 'catalog-app', name: 'Example app', description: 'An app',
    availability: 'available', kind: 'app', artifactInstanceId: 'artifact-a',
    version: { versionId: 'version-a', version: '1.0.0' }, sources, permissions: [],
  }
}

function catalogSkill(sources: unknown[]) {
  return {
    catalogEntryId: 'catalog-skill', name: 'Example skill', description: 'A skill',
    availability: 'available', kind: 'skill', artifactInstanceId: 'artifact-skill',
    version: { versionId: 'version-skill', version: '1.0.0' }, sources, permissions: [], enabled: true,
  }
}

function assistantEntry() {
  return {
    catalogEntryId: 'assistant', name: 'Polo assistant', description: 'Built in',
    availability: 'available', kind: 'built_in_app' as const, builtInAppId: 'polo_assistant' as const,
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
      {
        id: 'product-space-b', kind: 'enterprise', enterpriseId: 'enterprise-b', name: 'Enterprise',
        role: 'member', accessMode: 'active',
        payer: { kind: 'enterprise', enterpriseId: 'enterprise-other' },
      },
    ]) {
      expect(ListProductSpacesResponseSchema.safeParse({
        contractVersion: 1, personalProductSpaceId: 'product-space-a', productSpaces: [personalSpace(), invalid],
      }).success).toBe(false)
    }
    expect(ListProductSpacesResponseSchema.safeParse({
      contractVersion: 1, personalProductSpaceId: 'product-space-a',
      productSpaces: [
        personalSpace(),
        { ...enterpriseSpace(), id: 'product-space-enterprise-a' },
        { ...enterpriseSpace(), id: 'product-space-enterprise-b' },
      ],
    }).success).toBe(false)
  })

  test('rejects catalog subject confusion and sensitive delivery fields', () => {
    const assistant = assistantEntry()
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1', entries: [assistant],
    }).success).toBe(true)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [{ ...assistant, artifactInstanceId: 'must-not-be-on-built-in' }],
    }).success).toBe(false)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1', entries: [],
    }).success).toBe(false)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1', entries: [assistant, { ...assistant, catalogEntryId: 'assistant-duplicate' }],
    }).success).toBe(false)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [{ ...assistant, availability: 'blocked', unavailableReason: 'version_blocked' }],
    }).success).toBe(true)

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
      contractVersion: 1, productSpaceId: 'product-space-b', catalogRevision: 'r1', entries: [assistantEntry()],
    }, ProductSpaceRefSchema.parse({ id: 'product-space-a', kind: 'personal' }))).toThrow('did not match')
  })

  test('binds catalog entries to the trusted ProductSpace kind', () => {
    const personal = ProductSpaceRefSchema.parse({ id: 'product-space-a', kind: 'personal' })
    const enterprise = ProductSpaceRefSchema.parse({
      id: 'product-space-a', kind: 'enterprise', enterpriseId: 'enterprise-a', role: 'member',
    })
    const response = (entries: unknown[]) => ({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1', entries: [assistantEntry(), ...entries],
    })

    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'creator_circle', circleId: 'circle-a', name: 'Circle A' }]),
    ]), personal).entries).toHaveLength(2)
    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([
        { kind: 'creator_circle', circleId: 'circle-a', name: 'Circle A' },
        { kind: 'creator_circle', circleId: 'circle-b', name: 'Circle B' },
      ]),
    ]), personal).entries).toHaveLength(2)
    expect(parseProductSpaceCatalogResponseForProductSpace(response([]), personal).entries).toHaveLength(1)
    expect(() => parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'enterprise_import', name: 'Enterprise import' }]),
    ]), personal)).toThrow('did not match')
    expect(() => parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([
        { kind: 'polo', name: 'Polo' },
        { kind: 'creator_circle', circleId: 'circle-a', name: 'Circle A' },
      ]),
    ]), personal)).toThrow('did not match')
    expect(parseProductSpaceCatalogResponseForProductSpace(response([]), enterprise).entries).toHaveLength(1)
    expect(() => parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'creator_circle', circleId: 'circle-a', name: 'Circle A' }]),
    ]), enterprise)).toThrow('did not match')
    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'enterprise_import', name: 'Enterprise import' }]),
    ]), enterprise).entries).toHaveLength(2)
  })

  test('rejects duplicate artifact instances instead of splitting creator-circle grants', () => {
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [
        assistantEntry(),
        catalogApp([{ kind: 'creator_circle', circleId: 'circle-a', name: 'Circle A' }]),
        {
          ...catalogApp([{ kind: 'creator_circle', circleId: 'circle-b', name: 'Circle B' }]),
          catalogEntryId: 'catalog-app-second',
        },
      ],
    }).success).toBe(false)
  })

  test('binds resolve-launch to trusted space payer and Catalog subject', () => {
    const personal = ProductSpaceSummarySchema.parse(personalSpace())
    const enterprise = ProductSpaceSummarySchema.parse(enterpriseSpace())
    const assistant = ProductSpaceCatalogEntrySchema.parse(assistantEntry())
    const app = ProductSpaceCatalogEntrySchema.parse(catalogApp([{ kind: 'polo', name: 'Polo' }]))
    const skill = ProductSpaceCatalogEntrySchema.parse(catalogSkill([{ kind: 'polo', name: 'Polo' }]))
    const launch = {
      contractVersion: 1, productSpaceId: 'product-space-a', catalogEntryId: 'assistant',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      payer: { kind: 'account' }, delivery: { kind: 'built_in' },
    }
    expect(parseResolveLaunchResponseForProductSpace(
      launch, personal, assistant,
    ).catalogEntryId).toBe(assistant.catalogEntryId)
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...launch, catalogEntryId: 'catalog-other' }, personal, assistant,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...launch, productSpaceId: 'product-space-other' }, personal, assistant,
    )).toThrow('ProductSpace')
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...launch, payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' } }, personal, assistant,
    )).toThrow('ProductSpace')
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...launch, subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-a', versionId: 'version-new', version: '2.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, personal, assistant,
    )).toThrow('catalogEntryId')
    expect(parseResolveLaunchResponseForProductSpace(
      {
        ...launch, catalogEntryId: 'catalog-app',
        subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-a', versionId: 'version-new', version: '2.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, personal, app,
    ).subject).toMatchObject({ kind: 'artifact_instance', artifactType: 'app' })
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...launch, catalogEntryId: 'catalog-app',
        subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-a', versionId: 'version-new', version: '2.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, personal, app,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...launch, catalogEntryId: 'catalog-app' }, personal, app,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...launch, catalogEntryId: 'catalog-skill',
        subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-other', versionId: 'version-new', version: '2.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, personal, skill,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...launch, catalogEntryId: 'catalog-skill',
        subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-skill', versionId: 'version-new', version: '2.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, personal, skill,
    )).toThrow('catalogEntryId')
    expect(parseResolveLaunchResponseForProductSpace(
      {
        ...launch, catalogEntryId: 'catalog-skill',
        subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-skill', versionId: 'version-new', version: '2.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, personal, skill,
    ).subject).toMatchObject({ kind: 'artifact_instance', artifactType: 'skill' })
    expect(parseResolveLaunchResponseForProductSpace(
      { ...launch, payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' } }, enterprise, assistant,
    ).payer).toMatchObject({ kind: 'enterprise', enterpriseId: 'enterprise-a' })
    expect(parseResolveLaunchResponseForProductSpace(
      {
        ...launch, catalogEntryId: 'catalog-app', payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' },
        subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-a', versionId: 'version-new', version: '2.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, enterprise, app,
    ).subject).toMatchObject({ kind: 'artifact_instance', artifactType: 'app' })
    expect(() => parseResolveLaunchResponseForProductSpace(
      launch, enterprise, assistant,
    )).toThrow('ProductSpace')
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...launch, payer: { kind: 'enterprise', enterpriseId: 'enterprise-other' } }, enterprise, assistant,
    )).toThrow('ProductSpace')

    const enablement = {
      contractVersion: 1, productSpaceId: 'product-space-a', artifactInstanceId: 'artifact-skill',
      enabled: true, catalogRevision: 'r1',
    }
    expect(parseUpdateSkillEnablementResponseForProductSpace(
      enablement, personal, skill, true,
    ).artifactInstanceId).toBe(ArtifactInstanceIdSchema.parse('artifact-skill'))
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      { ...enablement, artifactInstanceId: 'artifact-other' }, personal, skill, true,
    )).toThrow('artifactInstanceId')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      { ...enablement, productSpaceId: 'product-space-other' }, personal, skill, true,
    )).toThrow('ProductSpace')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      { ...enablement, enabled: false }, personal, skill, true,
    )).toThrow('artifactInstanceId')
  })

  test('requires active ProductSpace and available Catalog entries before launch', () => {
    const personal = ProductSpaceSummarySchema.parse(personalSpace())
    const readOnlyEnterprise = ProductSpaceSummarySchema.parse(enterpriseSpace('read_only'))
    const assistant = ProductSpaceCatalogEntrySchema.parse(assistantEntry())
    const availableSkill = ProductSpaceCatalogEntrySchema.parse(catalogSkill([{ kind: 'polo', name: 'Polo' }]))
    const unavailableApp = ProductSpaceCatalogEntrySchema.parse({
      ...catalogApp([{ kind: 'polo', name: 'Polo' }]),
      availability: 'unavailable', unavailableReason: 'authorization_ended',
    })
    const blockedAssistant = ProductSpaceCatalogEntrySchema.parse({
      ...assistantEntry(), availability: 'blocked', unavailableReason: 'version_blocked',
    })
    const disabledSkill = ProductSpaceCatalogEntrySchema.parse({ ...catalogSkill([{ kind: 'polo', name: 'Polo' }]), enabled: false })
    const launch = {
      contractVersion: 1, productSpaceId: 'product-space-a', catalogEntryId: 'assistant',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      payer: { kind: 'account' }, delivery: { kind: 'built_in' },
    }
    expect(() => parseResolveLaunchResponseForProductSpace(launch, readOnlyEnterprise, assistant)).toThrow('ProductSpace')
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...launch, catalogEntryId: 'catalog-app',
        subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-a', versionId: 'version-a', version: '1.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, personal, unavailableApp,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(launch, personal, blockedAssistant)).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...launch, catalogEntryId: 'catalog-skill',
        subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-skill', versionId: 'version-skill', version: '1.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, personal, disabledSkill,
    )).toThrow('catalogEntryId')
    expect(parseResolveLaunchResponseForProductSpace(
      {
        ...launch, catalogEntryId: 'catalog-skill',
        subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-skill', versionId: 'version-new', version: '2.0.0' },
        delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
      }, personal, availableSkill,
    ).subject).toMatchObject({ artifactType: 'skill', version: '2.0.0' })
  })

  test('binds Skill enablement to the trusted Skill and permits idempotent disable convergence', () => {
    const personal = ProductSpaceSummarySchema.parse(personalSpace())
    const readOnlyEnterprise = ProductSpaceSummarySchema.parse(enterpriseSpace('read_only'))
    const skill = ProductSpaceCatalogEntrySchema.parse(catalogSkill([{ kind: 'polo', name: 'Polo' }]))
    const unavailableSkill = ProductSpaceCatalogEntrySchema.parse({
      ...catalogSkill([{ kind: 'polo', name: 'Polo' }]), availability: 'blocked', unavailableReason: 'version_blocked',
    })
    const app = ProductSpaceCatalogEntrySchema.parse(catalogApp([{ kind: 'polo', name: 'Polo' }]))
    const enabled = {
      contractVersion: 1, productSpaceId: 'product-space-a', artifactInstanceId: 'artifact-skill',
      enabled: true, catalogRevision: 'r1',
    }
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(enabled, readOnlyEnterprise, skill, true)).toThrow('ProductSpace')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(enabled, personal, unavailableSkill, true)).toThrow('ProductSpace')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(enabled, personal, app, true)).toThrow('artifactInstanceId')
    expect(parseUpdateSkillEnablementResponseForProductSpace(
      { ...enabled, enabled: false }, readOnlyEnterprise, skill, false,
    ).enabled).toBe(false)
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

  test('binds list-active and stop-all results to their requested tuple', () => {
    const expectedAccountId = AccountIdSchema.parse('account-a')
    const expectedProductSpaceId = ProductSpaceIdSchema.parse('product-space-a')
    const execution = {
      executionId: 'execution-a',
      scope: {
        contractVersion: 1, executionId: 'execution-a', accountId: 'account-a',
        productSpaceId: 'product-space-a', workspaceId: 'workspace-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      },
      name: 'Polo assistant', status: 'running',
    }
    expect(parseActiveExecutionsForProductSpace(
      [execution], expectedAccountId, expectedProductSpaceId,
    )).toHaveLength(1)
    expect(() => parseActiveExecutionsForProductSpace(
      [{ ...execution, scope: { ...execution.scope, accountId: 'account-other' } }],
      expectedAccountId, expectedProductSpaceId,
    )).toThrow('accountId')
    expect(() => parseActiveExecutionsForProductSpace(
      [{ ...execution, scope: { ...execution.scope, productSpaceId: 'product-space-other' } }],
      expectedAccountId, expectedProductSpaceId,
    )).toThrow('productSpaceId')
    expect(() => parseActiveExecutionsForProductSpace(
      [execution, { ...execution, name: 'Duplicate' }], expectedAccountId, expectedProductSpaceId,
    )).toThrow('duplicate executionId')

    const stoppedExecution = { ...execution, status: 'stopped' as const }
    const expectedExecutionScope = ProductSpaceExecutionScopeSchema.parse(execution.scope)
    expect(parseStopAllExecutionsResultForProductSpace(
      { allStopped: true, executions: [stoppedExecution] }, expectedAccountId, expectedProductSpaceId,
      [expectedExecutionScope],
    ).allStopped).toBe(true)
    expect(() => parseStopAllExecutionsResultForProductSpace(
      { allStopped: true, executions: [{ ...stoppedExecution, scope: { ...stoppedExecution.scope, accountId: 'account-other' } }] },
      expectedAccountId, expectedProductSpaceId,
      [expectedExecutionScope],
    )).toThrow('accountId')
    expect(() => parseStopAllExecutionsResultForProductSpace(
      { allStopped: true, executions: [{ ...stoppedExecution, scope: { ...stoppedExecution.scope, productSpaceId: 'product-space-other' } }] },
      expectedAccountId, expectedProductSpaceId,
      [expectedExecutionScope],
    )).toThrow('productSpaceId')
    expect(() => parseStopAllExecutionsResultForProductSpace(
      { allStopped: true, executions: [stoppedExecution, { ...stoppedExecution, name: 'Duplicate' }] },
      expectedAccountId, expectedProductSpaceId,
      [expectedExecutionScope],
    )).toThrow('duplicate executionId')
    expect(() => parseStopAllExecutionsResultForProductSpace(
      { allStopped: false, executions: [execution] }, expectedAccountId, expectedProductSpaceId,
      [expectedExecutionScope],
    )).toThrow('non-terminal')
    expect(() => parseStopAllExecutionsResultForProductSpace(
      { allStopped: true, executions: [] }, expectedAccountId, expectedProductSpaceId,
      [expectedExecutionScope],
    )).toThrow('omitted')
    expect(() => parseStopAllExecutionsResultForProductSpace(
      { allStopped: true, executions: [stoppedExecution] }, expectedAccountId, expectedProductSpaceId,
      [],
    )).toThrow('at least one expected')
    expect(() => parseStopAllExecutionsResultForProductSpace(
      {
        allStopped: true,
        executions: [{
          ...stoppedExecution,
          scope: { ...stoppedExecution.scope, workspaceId: 'workspace-other' },
        }],
      }, expectedAccountId, expectedProductSpaceId, [expectedExecutionScope],
    )).toThrow('changed an expected execution scope')

    const concurrentStoppedExecution = {
      ...stoppedExecution,
      executionId: 'execution-concurrent',
      scope: { ...stoppedExecution.scope, executionId: 'execution-concurrent' },
      name: 'Concurrent assistant',
    }
    expect(parseStopAllExecutionsResultForProductSpace(
      { allStopped: true, executions: [stoppedExecution, concurrentStoppedExecution] },
      expectedAccountId, expectedProductSpaceId, [expectedExecutionScope],
    ).executions).toHaveLength(2)
    expect(() => parseStopAllExecutionsResultForProductSpace(
      {
        allStopped: true,
        executions: [
          stoppedExecution,
          {
            ...concurrentStoppedExecution,
            scope: { ...concurrentStoppedExecution.scope, accountId: 'account-other' },
          },
        ],
      }, expectedAccountId, expectedProductSpaceId, [expectedExecutionScope],
    )).toThrow('accountId')
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
