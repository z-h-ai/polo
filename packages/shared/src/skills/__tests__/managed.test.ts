import { describe, expect, it } from 'bun:test'
import {
  ListManagedSkillsRequestSchema,
  ListManagedSkillsResponseSchema,
  SetManagedSkillEnablementRequestSchema,
  createEmptyManagedSkillEnablementDocument,
  isCanonicalManagedSkill,
  isLocalEnablementTarget,
  managedSkillEnablementError,
} from '../managed.ts'

const toggleRequest = {
  workspaceId: 'ws-one',
  slug: 'review-skill',
  source: 'workspace' as const,
  enabled: false,
}

describe('managed skill enablement contracts', () => {
  it('accepts a user-tier enablement write', () => {
    const parsed = SetManagedSkillEnablementRequestSchema.safeParse(toggleRequest)
    expect(parsed.success).toBe(true)
  })

  it('refuses bundled skills at the schema layer (SM-18d)', () => {
    const parsed = SetManagedSkillEnablementRequestSchema.safeParse({ ...toggleRequest, source: 'bundled' })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown fields and blank slugs', () => {
    expect(SetManagedSkillEnablementRequestSchema.safeParse({ ...toggleRequest, extra: true }).success).toBe(false)
    expect(SetManagedSkillEnablementRequestSchema.safeParse({ ...toggleRequest, slug: '' }).success).toBe(false)
    expect(SetManagedSkillEnablementRequestSchema.safeParse({ workspaceId: '' }).success).toBe(false)
  })

  it('keeps expectedRevision optional and integral', () => {
    expect(SetManagedSkillEnablementRequestSchema.safeParse({ ...toggleRequest, expectedRevision: 0 }).success).toBe(true)
    expect(SetManagedSkillEnablementRequestSchema.safeParse({ ...toggleRequest, expectedRevision: 1.5 }).success).toBe(false)
  })

  it('round-trips a list response with the inventory flags', () => {
    const response = {
      ok: true as const,
      workspaceId: 'ws-one',
      revision: 3,
      items: [
        { slug: 'bundled-one', source: 'bundled' as const, enabled: true, toggleable: false, managed: false, shadowedBuiltin: false },
        { slug: 'review-skill', source: 'workspace' as const, enabled: false, toggleable: true, managed: false, shadowedBuiltin: false },
        { slug: 'canonical-abc', source: 'workspace' as const, enabled: true, toggleable: false, managed: true, shadowedBuiltin: false },
        { slug: 'shadow-user', source: 'global' as const, enabled: true, toggleable: false, managed: false, shadowedBuiltin: true },
      ],
    }
    const parsed = ListManagedSkillsResponseSchema.parse(response)
    expect(parsed.items).toHaveLength(4)
    expect(ListManagedSkillsRequestSchema.safeParse({ workspaceId: 'ws-one' }).success).toBe(true)
    expect(ListManagedSkillsRequestSchema.safeParse({}).success).toBe(false)
  })

  it('classifies managed and toggle targets identically on both sides of the wire', () => {
    const base = { slug: 'skill-a' }
    expect(isLocalEnablementTarget({ ...base, source: 'workspace' })).toBe(true)
    expect(isLocalEnablementTarget({ ...base, source: 'bundled' })).toBe(false)
    expect(isCanonicalManagedSkill({ ...base, canonicalInstallation: {} as never })).toBe(true)
    expect(isCanonicalManagedSkill({ ...base, creatorInstallation: {} as never })).toBe(true)
    expect(isCanonicalManagedSkill({ slug: 'canonical-abc' })).toBe(true)
    expect(isCanonicalManagedSkill(base)).toBe(false)
    expect(isLocalEnablementTarget({ slug: 'canonical-abc', source: 'workspace' })).toBe(false)
  })

  it('builds typed refusals', () => {
    expect(managedSkillEnablementError('revision_conflict', { revision: 4 })).toEqual({
      ok: false,
      errorCode: 'revision_conflict',
      revision: 4,
    })
    expect(managedSkillEnablementError('VALIDATION_ERROR')).toEqual({ ok: false, errorCode: 'VALIDATION_ERROR' })
  })

  it('starts documents at revision 0 with no entries', () => {
    expect(createEmptyManagedSkillEnablementDocument()).toEqual({
      schemaVersion: 1,
      revision: 0,
      updatedAt: '1970-01-01T00:00:00.000Z',
      entries: {},
    })
  })
})
