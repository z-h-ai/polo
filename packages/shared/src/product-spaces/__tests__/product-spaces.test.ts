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
  ProductSpaceRefSchema,
  ProductSpaceSummarySchema,
  ResolveLaunchResponseSchema,
  StopAllExecutionsResultSchema,
  WorkspaceIdSchema,
  createProductSpaceCatalogKey,
  createProductSpaceRuntimeKey,
  invalidateLegacyOrganizationState,
  LEGACY_ORGANIZATION_STATE_INVALIDATION_STEPS,
  parseProductSpaceCatalogResponseForProductSpace,
  parseActiveExecutionsForProductSpace,
  parseResolveLaunchResponseForProductSpace,
  parseStopAllExecutionsResultForProductSpace,
  parseUpdateSkillEnablementResponseForProductSpace,
  createProductSpaceAppRuntimeIdentityKey,
  AppApiRunStartSchema,
  AppAiQuerySchema,
  AppApiRunFinishSchema,
  AppApiResultReportSchema,
  AppApiFileReportSchema,
  RUNTIME_PROJECTION_CONTRACT_VERSION,
  type AppRuntimeProjection,
  type EnterpriseId,
  type ProductSpaceId,
  type TrustedProductSpaceSummary,
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

// POO-205 Catalog v2: app entries must declare visibility ('space' | 'member');
// fixtures default to the space-shared row.
function catalogApp(sources: unknown[]) {
  return {
    catalogEntryId: 'catalog-app', name: 'Example app', description: 'An app',
    availability: 'available', kind: 'app', artifactInstanceId: 'artifact-a',
    version: { versionId: 'version-a', version: '1.0.0' }, sources, permissions: [],
    visibility: 'space',
  }
}

function catalogSkill(sources: unknown[]) {
  return {
    catalogEntryId: 'catalog-skill', name: 'Example skill', description: 'A skill',
    availability: 'available', kind: 'skill', artifactInstanceId: 'artifact-skill',
    version: { versionId: 'version-skill', version: '1.0.0' }, sources, permissions: [], enabled: true,
  }
}

// POO-205 Catalog v2: kept ONLY to prove built-in apps no longer parse as
// catalog entries — never used as a trusted fixture below.
function builtinEntry(builtInAppId: 'polo_assistant' | 'enterprise_knowledge') {
  return {
    catalogEntryId: builtInAppId === 'polo_assistant' ? 'assistant' : 'knowledge',
    name: 'Polo assistant', description: 'Built in',
    availability: 'available', kind: 'built_in_app' as const, builtInAppId,
  }
}

function trustedCatalog(context: TrustedProductSpaceSummary, entries: unknown[]) {
  return parseProductSpaceCatalogResponseForProductSpace({
    contractVersion: 1, productSpaceId: context.id, catalogRevision: 'r1', entries,
  }, context)
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
    // POO-205 Catalog v2: the directory no longer contains built-in app entries
    // — they fail schema parse outright, with or without artifact payload smuggled in.
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [builtinEntry('polo_assistant')],
    }).success).toBe(false)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [{ ...builtinEntry('polo_assistant'), artifactInstanceId: 'must-not-be-on-built-in' }],
    }).success).toBe(false)
    // v2: an empty Catalog is legal — a space may simply have no directory rows.
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1', entries: [],
    }).success).toBe(true)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [
        catalogApp([{ kind: 'polo', name: 'Polo' }]),
        { ...catalogApp([{ kind: 'polo', name: 'Polo' }]), catalogEntryId: 'catalog-app-duplicate' },
      ],
    }).success).toBe(false)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [{ ...catalogApp([{ kind: 'polo', name: 'Polo' }]), availability: 'blocked', unavailableReason: 'version_blocked' }],
    }).success).toBe(true)

    // Resolve-launch subjects still know built-in apps (execution/billing identity).
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

  test('v2: app visibility requires member rows to carry their owner account', () => {
    // POO-205 Catalog v2: `visibility` is mandatory on app entries; member rows
    // must bind to their owner account, space rows speak for the whole space.
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [{ ...catalogApp([{ kind: 'polo', name: 'Polo' }]), visibility: undefined }],
    }).success).toBe(false)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [{ ...catalogApp([{ kind: 'polo', name: 'Polo' }]), visibility: 'member' }],
    }).success).toBe(false)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [{
        ...catalogApp([{ kind: 'polo', name: 'Polo' }]),
        visibility: 'member', ownerAccountId: 'account-a',
      }],
    }).success).toBe(true)
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
      contractVersion: 1, productSpaceId: 'product-space-b', catalogRevision: 'r1',
      entries: [catalogApp([{ kind: 'polo', name: 'Polo' }])],
    }, ProductSpaceRefSchema.parse({ id: 'product-space-a', kind: 'personal' }))).toThrow('did not match')
  })

  test('binds catalog entries to the trusted ProductSpace kind', () => {
    // POO-205 Catalog v2: provenance subsets per space kind. `self` (member
    // "my apps") is legal in both kinds; mixing allowed sources is legal now.
    const personal = ProductSpaceRefSchema.parse({ id: 'product-space-a', kind: 'personal' })
    const enterprise = ProductSpaceRefSchema.parse({
      id: 'product-space-a', kind: 'enterprise', enterpriseId: 'enterprise-a', role: 'member',
    })
    const response = (entries: unknown[]) => ({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1', entries,
    })

    // personal allows {polo, creator_circle, self} in any combination.
    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'polo', name: 'Polo' }]),
    ]), personal).entries).toHaveLength(1)
    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'creator_circle', circleId: 'circle-a', name: 'Circle A' }]),
    ]), personal).entries).toHaveLength(1)
    // v2: mixed allowed provenance no longer rejects the entry.
    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([
        { kind: 'polo', name: 'Polo' },
        { kind: 'creator_circle', circleId: 'circle-a', name: 'Circle A' },
      ]),
    ]), personal).entries).toHaveLength(1)
    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'self', name: 'My app' }]),
    ]), personal).entries).toHaveLength(1)
    expect(() => parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'enterprise_import', name: 'Enterprise import' }]),
    ]), personal)).toThrow('did not match')
    // Unknown provenance kinds never parse (strict discriminated union).
    expect(() => parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'bazaar', name: 'Bazaar' }]),
    ]), personal)).toThrow()

    // enterprise allows {enterprise_import, self} in any combination.
    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'enterprise_import', name: 'Enterprise import' }]),
    ]), enterprise).entries).toHaveLength(1)
    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'self', name: 'My app' }]),
    ]), enterprise).entries).toHaveLength(1)
    expect(parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([
        { kind: 'enterprise_import', name: 'Enterprise import' },
        { kind: 'self', name: 'My app' },
      ]),
    ]), enterprise).entries).toHaveLength(1)
    expect(() => parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'polo', name: 'Polo' }]),
    ]), enterprise)).toThrow('did not match')
    expect(() => parseProductSpaceCatalogResponseForProductSpace(response([
      catalogApp([{ kind: 'creator_circle', circleId: 'circle-a', name: 'Circle A' }]),
    ]), enterprise)).toThrow('did not match')
    // v2: an empty Catalog is a valid snapshot for either space kind.
    expect(parseProductSpaceCatalogResponseForProductSpace(response([]), personal).entries).toHaveLength(0)
    expect(parseProductSpaceCatalogResponseForProductSpace(response([]), enterprise).entries).toHaveLength(0)
  })

  test('v2: built_in_app leaves the Catalog (POO-108 knowledge base included)', () => {
    // POO-205 Catalog v2: neither the Polo assistant nor the retired enterprise
    // knowledge base parses as a catalog entry anymore — the directory lists
    // only artifact-backed apps and skills.
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [builtinEntry('polo_assistant')],
    }).success).toBe(false)
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [builtinEntry('enterprise_knowledge')],
    }).success).toBe(false)

    // Execution subjects keep the built-in identity with built_in delivery only.
    const launch = {
      contractVersion: 1, productSpaceId: 'product-space-a', catalogEntryId: 'knowledge',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'built_in_app', builtInAppId: 'enterprise_knowledge' },
      payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' },
      delivery: { kind: 'built_in' },
    }
    expect(ResolveLaunchResponseSchema.safeParse(launch).success).toBe(true)
  })

  test('rejects duplicate artifact instances instead of splitting creator-circle grants', () => {
    expect(ProductSpaceCatalogResponseSchema.safeParse({
      contractVersion: 1, productSpaceId: 'product-space-a', catalogRevision: 'r1',
      entries: [
        catalogApp([{ kind: 'creator_circle', circleId: 'circle-a', name: 'Circle A' }]),
        {
          ...catalogApp([{ kind: 'creator_circle', circleId: 'circle-b', name: 'Circle B' }]),
          catalogEntryId: 'catalog-app-second',
        },
      ],
    }).success).toBe(false)
  })

  test('binds resolve-launch to trusted space payer and Catalog subject', () => {
    // POO-205 Catalog v2: trusted catalogs hold only app/skill entries, so every
    // happy path resolves an artifact_instance subject over web_url delivery;
    // the built-in assistant row and its resolve-launch path no longer exist.
    const personal = ProductSpaceSummarySchema.parse(personalSpace())
    const enterprise = ProductSpaceSummarySchema.parse(enterpriseSpace())
    const appId = CatalogEntryIdSchema.parse('catalog-app')
    const skillId = CatalogEntryIdSchema.parse('catalog-skill')
    const skillArtifactInstanceId = ArtifactInstanceIdSchema.parse('artifact-skill')
    const personalCatalog = trustedCatalog(personal, [
      catalogApp([{ kind: 'polo', name: 'Polo' }]),
      catalogSkill([{ kind: 'polo', name: 'Polo' }]),
    ])
    const enterpriseCatalog = trustedCatalog(enterprise, [
      catalogApp([{ kind: 'enterprise_import', name: 'Enterprise import' }]),
      catalogSkill([{ kind: 'enterprise_import', name: 'Enterprise import' }]),
    ])
    const appLaunch = {
      contractVersion: 1, productSpaceId: 'product-space-a', catalogEntryId: 'catalog-app',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-a', versionId: 'version-a', version: '1.0.0' },
      payer: { kind: 'account' },
      delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
    }
    expect(parseResolveLaunchResponseForProductSpace(
      appLaunch, personal, personalCatalog, appId,
    ).subject).toMatchObject({ kind: 'artifact_instance', artifactType: 'app' })
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...appLaunch, catalogEntryId: 'catalog-other' }, personal, personalCatalog, appId,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...appLaunch, productSpaceId: 'product-space-other' }, personal, personalCatalog, appId,
    )).toThrow('ProductSpace')
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...appLaunch, payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' } }, personal, personalCatalog, appId,
    )).toThrow('ProductSpace')
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...appLaunch,
        subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-a', versionId: 'version-new', version: '2.0.0' },
      }, personal, personalCatalog, appId,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...appLaunch,
        subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-a', versionId: 'version-new', version: '2.0.0' },
      }, personal, personalCatalog, appId,
    )).toThrow('catalogEntryId')
    // Catalog v2: a built-in subject replayed against an app entry is a subject
    // mismatch, never a launch — built-ins are not catalog entries anymore.
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...appLaunch,
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
        delivery: { kind: 'built_in' },
      }, personal, personalCatalog, appId,
    )).toThrow('catalogEntryId')

    const skillLaunch = {
      contractVersion: 1, productSpaceId: 'product-space-a', catalogEntryId: 'catalog-skill',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-skill', versionId: 'version-skill', version: '1.0.0' },
      payer: { kind: 'account' },
      delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
    }
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...skillLaunch,
        subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-other', versionId: 'version-skill', version: '1.0.0' },
      }, personal, personalCatalog, skillId,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      {
        ...skillLaunch,
        subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-skill', versionId: 'version-skill', version: '1.0.0' },
      }, personal, personalCatalog, skillId,
    )).toThrow('catalogEntryId')
    expect(parseResolveLaunchResponseForProductSpace(
      skillLaunch, personal, personalCatalog, skillId,
    ).subject).toMatchObject({ kind: 'artifact_instance', artifactType: 'skill' })

    expect(parseResolveLaunchResponseForProductSpace(
      { ...appLaunch, payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' } }, enterprise, enterpriseCatalog, appId,
    ).payer).toMatchObject({ kind: 'enterprise', enterpriseId: 'enterprise-a' })
    // A personal (account-payer) launch replayed at the enterprise boundary is a
    // scope violation even though the entry exists in both catalogs.
    expect(() => parseResolveLaunchResponseForProductSpace(
      appLaunch, enterprise, enterpriseCatalog, appId,
    )).toThrow('ProductSpace')
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...appLaunch, payer: { kind: 'enterprise', enterpriseId: 'enterprise-other' } }, enterprise, enterpriseCatalog, appId,
    )).toThrow('ProductSpace')

    const enablement = {
      contractVersion: 1, productSpaceId: 'product-space-a', artifactInstanceId: 'artifact-skill',
      enabled: true, catalogRevision: 'r1',
    }
    expect(parseUpdateSkillEnablementResponseForProductSpace(
      enablement, personal, personalCatalog, skillArtifactInstanceId, true,
    ).artifactInstanceId).toBe(skillArtifactInstanceId)
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      { ...enablement, artifactInstanceId: 'artifact-other' }, personal, personalCatalog, skillArtifactInstanceId, true,
    )).toThrow('artifactInstanceId')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      { ...enablement, productSpaceId: 'product-space-other' }, personal, personalCatalog, skillArtifactInstanceId, true,
    )).toThrow('ProductSpace')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      { ...enablement, enabled: false }, personal, personalCatalog, skillArtifactInstanceId, true,
    )).toThrow('artifactInstanceId')
  })

  test('requires active ProductSpace and available Catalog entries before launch', () => {
    // POO-205 Catalog v2: the trusted-state gates are now expressed purely with
    // app/skill entries — there is no built-in row to lean on.
    const personal = ProductSpaceSummarySchema.parse(personalSpace())
    const readOnlyEnterprise = ProductSpaceSummarySchema.parse(enterpriseSpace('read_only'))
    const appId = CatalogEntryIdSchema.parse('catalog-app')
    const skillId = CatalogEntryIdSchema.parse('catalog-skill')
    const availableSkill = catalogSkill([{ kind: 'polo', name: 'Polo' }])
    const unavailableApp = {
      ...catalogApp([{ kind: 'polo', name: 'Polo' }]),
      availability: 'unavailable', unavailableReason: 'authorization_ended',
    }
    const blockedApp = {
      ...catalogApp([{ kind: 'polo', name: 'Polo' }]),
      availability: 'blocked', unavailableReason: 'version_blocked',
    }
    const disabledSkill = { ...catalogSkill([{ kind: 'polo', name: 'Polo' }]), enabled: false }
    const readOnlyCatalog = trustedCatalog(readOnlyEnterprise, [
      catalogApp([{ kind: 'enterprise_import', name: 'Enterprise import' }]),
    ])
    const unavailableAppCatalog = trustedCatalog(personal, [unavailableApp])
    const blockedAppCatalog = trustedCatalog(personal, [blockedApp])
    const disabledSkillCatalog = trustedCatalog(personal, [disabledSkill])
    const availableSkillCatalog = trustedCatalog(personal, [availableSkill])
    const appLaunch = {
      contractVersion: 1, productSpaceId: 'product-space-a', catalogEntryId: 'catalog-app',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-a', versionId: 'version-a', version: '1.0.0' },
      payer: { kind: 'account' },
      delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
    }
    const skillLaunch = {
      contractVersion: 1, productSpaceId: 'product-space-a', catalogEntryId: 'catalog-skill',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-skill', versionId: 'version-skill', version: '1.0.0' },
      payer: { kind: 'account' },
      delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
    }
    expect(() => parseResolveLaunchResponseForProductSpace(
      { ...appLaunch, payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' } }, readOnlyEnterprise, readOnlyCatalog, appId,
    )).toThrow('ProductSpace')
    expect(() => parseResolveLaunchResponseForProductSpace(
      appLaunch, personal, unavailableAppCatalog, appId,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      appLaunch, personal, blockedAppCatalog, appId,
    )).toThrow('catalogEntryId')
    expect(() => parseResolveLaunchResponseForProductSpace(
      skillLaunch, personal, disabledSkillCatalog, skillId,
    )).toThrow('catalogEntryId')
    expect(parseResolveLaunchResponseForProductSpace(
      skillLaunch, personal, availableSkillCatalog, skillId,
    ).subject).toMatchObject({ artifactType: 'skill', version: '1.0.0' })
  })

  test('binds Skill enablement to the trusted Skill and permits idempotent disable convergence', () => {
    const personal = ProductSpaceSummarySchema.parse(personalSpace())
    const readOnlyEnterprise = ProductSpaceSummarySchema.parse(enterpriseSpace('read_only'))
    const skillArtifactInstanceId = ArtifactInstanceIdSchema.parse('artifact-skill')
    const skill = catalogSkill([{ kind: 'enterprise_import', name: 'Enterprise import' }])
    const unavailableSkill = {
      ...catalogSkill([{ kind: 'polo', name: 'Polo' }]), availability: 'blocked', unavailableReason: 'version_blocked',
    }
    const app = catalogApp([{ kind: 'polo', name: 'Polo' }])
    const readOnlyCatalog = trustedCatalog(readOnlyEnterprise, [skill])
    const unavailableSkillCatalog = trustedCatalog(personal, [unavailableSkill])
    const appCatalog = trustedCatalog(personal, [app])
    const enabled = {
      contractVersion: 1, productSpaceId: 'product-space-a', artifactInstanceId: 'artifact-skill',
      enabled: true, catalogRevision: 'r1',
    }
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      enabled, readOnlyEnterprise, readOnlyCatalog, skillArtifactInstanceId, true,
    )).toThrow('ProductSpace')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      enabled, personal, unavailableSkillCatalog, skillArtifactInstanceId, true,
    )).toThrow('ProductSpace')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      enabled, personal, appCatalog, ArtifactInstanceIdSchema.parse('artifact-a'), true,
    )).toThrow('artifactInstanceId')
    expect(parseUpdateSkillEnablementResponseForProductSpace(
      { ...enabled, enabled: false }, readOnlyEnterprise, readOnlyCatalog, skillArtifactInstanceId, false,
    ).enabled).toBe(false)
  })

  test('rejects a Catalog entry trusted for ProductSpace A at ProductSpace B boundaries', () => {
    const spaceA = ProductSpaceSummarySchema.parse({
      ...enterpriseSpace(), id: 'product-space-a', enterpriseId: 'enterprise-a',
      payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' },
    })
    const spaceB = ProductSpaceSummarySchema.parse({
      ...enterpriseSpace(), id: 'product-space-b', enterpriseId: 'enterprise-b',
      payer: { kind: 'enterprise', enterpriseId: 'enterprise-b' },
    })
    const catalogForSpaceA = trustedCatalog(spaceA, [
      catalogSkill([{ kind: 'enterprise_import', name: 'Enterprise import' }]),
    ])
    const skillId = CatalogEntryIdSchema.parse('catalog-skill')
    const skillArtifactInstanceId = ArtifactInstanceIdSchema.parse('artifact-skill')
    const launchForSpaceB = {
      contractVersion: 1, productSpaceId: 'product-space-b', catalogEntryId: 'catalog-skill',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-skill', versionId: 'version-a', version: '1.0.0' },
      payer: { kind: 'enterprise', enterpriseId: 'enterprise-b' },
      delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
    }
    expect(() => parseResolveLaunchResponseForProductSpace(
      launchForSpaceB, spaceB, catalogForSpaceA, skillId,
    )).toThrow('ProductSpace')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      {
        contractVersion: 1, productSpaceId: 'product-space-b', artifactInstanceId: 'artifact-skill',
        enabled: true, catalogRevision: 'r1',
      }, spaceB, catalogForSpaceA, skillArtifactInstanceId, true,
    )).toThrow('ProductSpace')
  })

  test('returns a deep immutable Catalog snapshot after ProductSpace validation', () => {
    const spaceA = ProductSpaceSummarySchema.parse({
      ...enterpriseSpace(), id: 'product-space-a', enterpriseId: 'enterprise-a',
      payer: { kind: 'enterprise', enterpriseId: 'enterprise-a' },
    })
    const spaceB = ProductSpaceSummarySchema.parse({
      ...enterpriseSpace(), id: 'product-space-b', enterpriseId: 'enterprise-b',
      payer: { kind: 'enterprise', enterpriseId: 'enterprise-b' },
    })
    const spaceASkill = catalogSkill([{ kind: 'enterprise_import', name: 'Enterprise import A' }])
    const spaceAApp = catalogApp([{ kind: 'enterprise_import', name: 'Enterprise import A' }])
    const rawBlockedSkill = {
      ...catalogSkill([{ kind: 'enterprise_import', name: 'Enterprise import B' }]),
      availability: 'blocked', unavailableReason: 'version_blocked', enabled: false,
    }
    const catalogForSpaceA = trustedCatalog(spaceA, [spaceASkill, spaceAApp])
    const catalogForSpaceB = trustedCatalog(spaceB, [rawBlockedSkill])
    const frozenSkill = catalogForSpaceB.entries.find(entry => entry.kind === 'skill')
    if (!frozenSkill || frozenSkill.kind !== 'skill') throw new Error('test fixture must contain a Skill')

    const assertDeepReadonly = () => {
      // @ts-expect-error Trusted Catalog entries are readonly.
      catalogForSpaceB.entries.push(catalogForSpaceA.entries[1]!)
      // @ts-expect-error Trusted Catalog entry fields are readonly.
      frozenSkill.artifactInstanceId = ArtifactInstanceIdSchema.parse('artifact-other')
      // @ts-expect-error Trusted nested version fields are readonly.
      frozenSkill.version.version = '2.0.0'
    }
    void assertDeepReadonly

    expect(Object.isFrozen(catalogForSpaceB)).toBe(true)
    expect(Object.isFrozen(catalogForSpaceB.entries)).toBe(true)
    expect(Object.isFrozen(frozenSkill)).toBe(true)
    expect(Object.isFrozen(frozenSkill.version)).toBe(true)
    expect(Object.isFrozen(frozenSkill.sources)).toBe(true)
    expect(Object.isFrozen(frozenSkill.sources[0])).toBe(true)
    expect(Object.isFrozen(frozenSkill.permissions)).toBe(true)
    expect(() => {
      (catalogForSpaceB.entries as unknown as unknown[]).push(catalogForSpaceA.entries[1])
    }).toThrow()
    expect(() => {
      (frozenSkill as unknown as { artifactInstanceId: string }).artifactInstanceId = 'artifact-other'
    }).toThrow()
    expect(() => {
      (frozenSkill as unknown as { availability: string }).availability = 'available'
    }).toThrow()
    expect(() => {
      (frozenSkill as unknown as { enabled: boolean }).enabled = true
    }).toThrow()

    rawBlockedSkill.availability = 'available'
    rawBlockedSkill.enabled = true
    expect(frozenSkill.availability).toBe('blocked')
    expect(frozenSkill.enabled).toBe(false)

    const skillId = CatalogEntryIdSchema.parse('catalog-skill')
    const skillArtifactInstanceId = ArtifactInstanceIdSchema.parse('artifact-skill')
    const launchForSpaceB = {
      contractVersion: 1, productSpaceId: 'product-space-b', catalogEntryId: 'catalog-skill',
      resolvedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:05:00.000Z',
      subject: { kind: 'artifact_instance', artifactType: 'skill', artifactInstanceId: 'artifact-skill', versionId: 'version-a', version: '1.0.0' },
      payer: { kind: 'enterprise', enterpriseId: 'enterprise-b' },
      delivery: { kind: 'web_url', url: 'https://app.example.test', launchToken: 'token' },
    }
    expect(() => parseResolveLaunchResponseForProductSpace(
      launchForSpaceB, spaceB, catalogForSpaceB, skillId,
    )).toThrow('catalogEntryId')
    expect(() => parseUpdateSkillEnablementResponseForProductSpace(
      {
        contractVersion: 1, productSpaceId: 'product-space-b', artifactInstanceId: 'artifact-skill',
        enabled: true, catalogRevision: 'r1',
      }, spaceB, catalogForSpaceB, skillArtifactInstanceId, true,
    )).toThrow('ProductSpace')
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
    // R36-2: a nonterminal stop-all result is the explicit survivor contract
    // — allStopped=false with real active statuses parses and stays
    // nonterminal, while allStopped=true over a live row stays a
    // contradiction.
    expect(parseStopAllExecutionsResultForProductSpace(
      { allStopped: false, executions: [execution] }, expectedAccountId, expectedProductSpaceId,
      [expectedExecutionScope],
    ).allStopped).toBe(false)
    expect(() => parseStopAllExecutionsResultForProductSpace(
      { allStopped: true, executions: [execution] }, expectedAccountId, expectedProductSpaceId,
      [expectedExecutionScope],
    )).toThrow('allStopped must reflect')
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
  const invalidator = {
    removeLegacyOrganizationAuthorizationCache: () => { calls.push('authorization') },
    removeLegacyOrganizationCatalogCache: () => { calls.push('catalog') },
    removeLegacyOrganizationInstallationStateCache: () => { calls.push('installation-state') },
    removeLegacyOrganizationRuntimeCache: () => { calls.push('runtime') },
    removeLegacyOrganizationSkillEnablementCache: () => { calls.push('skill-enablement') },
    removeLegacyOrganizationSessionIndex: () => { calls.push('session-index') },
  }
  expect(Object.keys(invalidator)).toEqual([
    'removeLegacyOrganizationAuthorizationCache',
    'removeLegacyOrganizationCatalogCache',
    'removeLegacyOrganizationInstallationStateCache',
    'removeLegacyOrganizationRuntimeCache',
    'removeLegacyOrganizationSkillEnablementCache',
    'removeLegacyOrganizationSessionIndex',
  ])
  expect(Object.values(invalidator).every(remove => remove.length === 0)).toBe(true)
  await invalidateLegacyOrganizationState(invalidator)
  expect(calls).toEqual([
    'authorization', 'catalog', 'installation-state', 'runtime', 'skill-enablement', 'session-index',
  ])
  expect(calls).toEqual([...LEGACY_ORGANIZATION_STATE_INVALIDATION_STEPS])
})

test('contract IDs are parsed before boundary use', () => {
  expect(ArtifactInstanceIdSchema.safeParse('  ').success).toBe(false)
  expect(CatalogEntryIdSchema.safeParse('').success).toBe(false)
  expect(WorkspaceIdSchema.safeParse('workspace').success).toBe(true)
})

describe('product-space app runtime contract (POO-54)', () => {
  const identity = {
    accountId: 'account-a',
    productSpaceId: 'space-a',
    artifactInstanceId: 'artifact-a',
    versionId: 'version-a',
    version: '1.0.0',
  }

  test('runtime identity key is a versioned JSON tuple without workspace or catalog entry', () => {
    expect(createProductSpaceAppRuntimeIdentityKey(identity)).toBe(JSON.stringify([
      'product-space-app-runtime', 1, 'account-a', 'space-a', 'artifact-a', 'version-a',
    ]))
    // Same artifact different version NEVER shares a runtime key.
    expect(createProductSpaceAppRuntimeIdentityKey({ ...identity, versionId: 'version-b' }))
      .not.toBe(createProductSpaceAppRuntimeIdentityKey(identity))
    // personal-A vs enterprise-B same-named App never collide.
    expect(createProductSpaceAppRuntimeIdentityKey({ ...identity, productSpaceId: 'space-b' }))
      .not.toBe(createProductSpaceAppRuntimeIdentityKey(identity))
    expect(createProductSpaceAppRuntimeIdentityKey({ ...identity, accountId: 'account-b' }))
      .not.toBe(createProductSpaceAppRuntimeIdentityKey(identity))
  })

  test('strict local-app-api schemas reject unknown ownership and secret fields', () => {
    expect(AppApiRunStartSchema.safeParse({ runId: crypto.randomUUID() }).success).toBe(true)
    // A malicious App self-reporting account/ProductSpace/payer is rejected.
    expect(AppApiRunStartSchema.safeParse({
      runId: crypto.randomUUID(),
      accountId: 'account-b',
    }).success).toBe(false)
    const query = {
      runId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      prompt: 'hello',
      maxOutputTokens: 128,
      timeoutMs: 5_000,
    }
    expect(AppAiQuerySchema.safeParse(query).success).toBe(true)
    // POL-280: an omitted budget resolves host-side to the selected model's own output limit.
    const { maxOutputTokens: _omitted, ...queryWithoutBudget } = query
    expect(AppAiQuerySchema.safeParse(queryWithoutBudget).success).toBe(true)
    expect(AppAiQuerySchema.safeParse({ ...query, workspaceId: 'ws' }).success).toBe(false)
    expect(AppAiQuerySchema.safeParse({ ...query, payer: 'enterprise' }).success).toBe(false)
    expect(AppAiQuerySchema.safeParse({ ...query, price: 1 }).success).toBe(false)
    expect(AppAiQuerySchema.safeParse({ ...query, maxOutputTokens: 131_073 }).success).toBe(false)
    expect(AppAiQuerySchema.safeParse({ ...query, timeoutMs: 999 }).success).toBe(false)
    expect(AppApiRunFinishSchema.safeParse({ runId: query.runId, status: 'completed' }).success).toBe(true)
    expect(AppApiRunFinishSchema.safeParse({ runId: query.runId, status: 'running' }).success).toBe(false)
    expect(AppApiResultReportSchema.safeParse({
      runId: query.runId,
      requestId: query.requestId,
      resultId: crypto.randomUUID(),
      title: 't',
    }).success).toBe(true)
    expect(AppApiResultReportSchema.safeParse({
      runId: query.runId,
      requestId: query.requestId,
      resultId: crypto.randomUUID(),
      title: 't',
      associatedFileIds: Array.from({ length: 33 }, () => crypto.randomUUID()),
    }).success).toBe(false)
    expect(AppApiFileReportSchema.safeParse({
      runId: query.runId,
      requestId: query.requestId,
      fileId: crypto.randomUUID(),
      source: 'app_export',
      displayName: 'f',
      candidatePath: '/tmp/f',
    }).success).toBe(true)
    expect(AppApiFileReportSchema.safeParse({
      runId: query.runId,
      requestId: query.requestId,
      fileId: crypto.randomUUID(),
      source: 'other',
      displayName: 'f',
      candidatePath: '/tmp/f',
    }).success).toBe(false)
  })

  test('projection DTO keeps workspace independent from the runtime identity', () => {
    const projection: AppRuntimeProjection = {
      contractVersion: RUNTIME_PROJECTION_CONTRACT_VERSION,
      identityKey: createProductSpaceAppRuntimeIdentityKey(identity),
      identity,
      workspaceId: 'ws-a',
      executionId: 'local-app:space-a:artifact-a:1',
      runtimeGeneration: 7,
      scopeGeneration: 2,
      runtimeKind: 'python',
      status: 'running',
      revision: 1,
    }
    // The same runtime identity under another workspace is a distinct
    // execution/projection row, never a different runtime key.
    const otherWorkspace = { ...projection, workspaceId: 'ws-b', executionId: 'e2', revision: 2 }
    expect(otherWorkspace.identityKey).toBe(projection.identityKey)
    expect(otherWorkspace.workspaceId).not.toBe(projection.workspaceId)
    expect(projection).not.toHaveProperty('prompt')
    expect(projection).not.toHaveProperty('capability')
  })
})

describe('POO-54 R2 content-free identifier and byte-bound contracts', () => {
  const validQuery = () => ({
    runId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    prompt: 'hello',
    maxOutputTokens: 64,
    timeoutMs: 5_000,
  })

  test('identifiers are strict UUID v4 — v1, v5 and nil are rejected', () => {
    expect(AppAiQuerySchema.safeParse(validQuery()).success).toBe(true)
    // Uppercase canonical v4 still parses.
    expect(AppAiQuerySchema.safeParse({
      ...validQuery(),
      runId: crypto.randomUUID().toUpperCase(),
    }).success).toBe(true)
    for (const [field, value] of [
      ['runId', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'], // UUID v1
      ['runId', '74738ff5-5367-5958-9aee-98fffdcd1876'], // UUID v5
      ['runId', '00000000-0000-0000-0000-000000000000'], // nil UUID
    ] as const) {
      expect(AppAiQuerySchema.safeParse({ ...validQuery(), [field]: value }).success)
        .toBe(false)
    }
    expect(AppApiRunStartSchema.safeParse({
      runId: '00000000-0000-0000-0000-000000000000',
    }).success).toBe(false)
  })

  test('prompt/systemPrompt bounds are UTF-8 BYTE bounds, not character counts', () => {
    // 400000 汉字 = 1,200,000 bytes > 1 MiB: rejected despite 400000 chars.
    expect(AppAiQuerySchema.safeParse({
      ...validQuery(),
      prompt: '汉'.repeat(400_000),
    }).success).toBe(false)
    // Multi-byte boundary: exactly 1 MiB of 4-byte emoji is accepted.
    expect(AppAiQuerySchema.safeParse({
      ...validQuery(),
      prompt: '😀'.repeat(262_144),
    }).success).toBe(true)
    expect(AppAiQuerySchema.safeParse({
      ...validQuery(),
      prompt: '😀'.repeat(262_145),
    }).success).toBe(false)
    // 3-byte boundary just below/above the limit.
    expect(AppAiQuerySchema.safeParse({
      ...validQuery(),
      prompt: '汉'.repeat(349_525),
    }).success).toBe(true)
    expect(AppAiQuerySchema.safeParse({
      ...validQuery(),
      prompt: '汉'.repeat(349_526),
    }).success).toBe(false)
    // systemPrompt: 512 KiB byte bound.
    expect(AppAiQuerySchema.safeParse({
      ...validQuery(),
      systemPrompt: 'a'.repeat(524_288),
    }).success).toBe(true)
    expect(AppAiQuerySchema.safeParse({
      ...validQuery(),
      systemPrompt: 'a'.repeat(524_289),
    }).success).toBe(false)
    expect(AppAiQuerySchema.safeParse({
      ...validQuery(),
      systemPrompt: '汉'.repeat(200_000),
    }).success).toBe(false)
  })
})
