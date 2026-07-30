import { describe, expect, it } from 'bun:test'
import {
  CreateCreatorArtifactRpcInputSchema,
  CreatorArtifactCatalogPageSchema,
  CreatorSkillInstallRpcInputSchema,
  SkillArchivePolicySchema,
  StableSemverSchema,
} from '../schemas'
import { HARD_SKILL_ARCHIVE_POLICY } from '../types'

describe('Creator Skill boundary schemas', () => {
  it('strips unknown Admin response fields recursively', () => {
    const parsed = CreatorArtifactCatalogPageSchema.parse({
      artifacts: [{
        id: 'artifact-id',
        organizationId: 'organization-id',
        type: 'skill',
        slug: 'review-helper',
        status: 'published',
        createdByUserId: 'user-id',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
        serverOnly: 'secret',
      }],
      nextCursor: 'cursor',
      anotherServerField: true,
    })
    expect(parsed).toEqual({
      artifacts: [{
        id: 'artifact-id',
        organizationId: 'organization-id',
        type: 'skill',
        slug: 'review-helper',
        status: 'published',
        createdByUserId: 'user-id',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      }],
      nextCursor: 'cursor',
    })
  })

  it('keeps legacy Web App identifiers opaque while enforcing Skill slugs', () => {
    const common = {
      id: 'artifact-id',
      organizationId: 'organization-id',
      status: 'published',
      createdByUserId: 'user-id',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    }
    expect(CreatorArtifactCatalogPageSchema.safeParse({
      artifacts: [{ ...common, type: 'web_app', slug: 'Legacy_App' }],
    }).success).toBe(true)
    expect(CreatorArtifactCatalogPageSchema.safeParse({
      artifacts: [{ ...common, type: 'skill', slug: 'Legacy_App' }],
    }).success).toBe(false)
  })

  it('rejects unknown renderer RPC input fields', () => {
    expect(CreateCreatorArtifactRpcInputSchema.safeParse({
      organizationId: 'organization-id',
      type: 'skill',
      slug: 'review-helper',
      idempotencyKey: 'idempotency-key',
      injected: true,
    }).success).toBe(false)

    expect(CreatorSkillInstallRpcInputSchema.safeParse({
      workspaceId: 'workspace-id',
      operationId: 'operation-id',
      grant: {},
      injected: true,
    }).success).toBe(false)
  })

  it('accepts only stable SemVer and never permits policy values above hard limits', () => {
    expect(StableSemverSchema.safeParse('1.2.3').success).toBe(true)
    expect(StableSemverSchema.safeParse('1.2.3-beta.1').success).toBe(false)
    expect(SkillArchivePolicySchema.safeParse({
      ...HARD_SKILL_ARCHIVE_POLICY,
      maxArchiveBytes: HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes + 1,
    }).success).toBe(false)
  })
})
