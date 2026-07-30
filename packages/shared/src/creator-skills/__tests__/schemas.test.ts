import { describe, expect, it } from 'bun:test'
import {
  CreateCreatorArtifactRpcInputSchema,
  CreatorArtifactCatalogPageSchema,
  CreatorSkillInstallRpcInputSchema,
  DeleteSkillRpcInputSchema,
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

    expect(DeleteSkillRpcInputSchema.safeParse({
      workspaceId: 'workspace-id',
      skillSlug: 'review-helper',
      injected: true,
    }).success).toBe(false)
  })

  it('rejects unsafe Skill slugs at the delete RPC boundary', () => {
    for (const skillSlug of [
      '..',
      '../outside',
      '/absolute/outside',
      '..\\outside',
      '../\\outside',
    ]) {
      expect(DeleteSkillRpcInputSchema.safeParse({
        workspaceId: 'workspace-id',
        skillSlug,
      }).success).toBe(false)
    }
  })

  it('accepts only stable SemVer and never permits policy values above hard limits', () => {
    expect(StableSemverSchema.safeParse('1.2.3').success).toBe(true)
    expect(StableSemverSchema.safeParse('1.2.3-beta.1').success).toBe(false)
    expect(SkillArchivePolicySchema.safeParse({
      ...HARD_SKILL_ARCHIVE_POLICY,
      maxArchiveBytes: HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes + 1,
    }).success).toBe(false)
  })

  it('requires UUID operation identifiers at the renderer RPC boundary', () => {
    const base = {
      workspaceId: 'workspace-id',
      grant: {
        artifactId: 'artifact-id',
        organizationId: 'organization-id',
        slug: 'review-helper',
        version: '1.0.0',
        url: 'https://download.example.test/skill.zip',
        expiresAt: '2026-07-30T00:01:00.000Z',
        archiveChecksum: 'a'.repeat(64),
        contentDigest: 'b'.repeat(64),
        manifest: [],
        validationPolicy: HARD_SKILL_ARCHIVE_POLICY,
      },
    }
    expect(CreatorSkillInstallRpcInputSchema.safeParse({
      ...base,
      operationId: '11111111-1111-4111-8111-111111111111',
    }).success).toBe(true)
    expect(CreatorSkillInstallRpcInputSchema.safeParse({
      ...base,
      operationId: '../outside',
    }).success).toBe(false)
  })
})
