import { describe, expect, it } from 'bun:test'
import { creatorSkillHasStaleSafetyStatus } from '../creator-skill-safety-display'
import type { LoadedSkill } from '../../../shared/types'

function skill(status?: 'checking' | 'ok' | 'failed'): LoadedSkill {
  return {
    slug: 'review-skill',
    metadata: { name: 'Review Skill', description: 'Review.' },
    content: 'Instructions.',
    path: '/workspace/skills/review-skill',
    source: 'workspace',
    creatorSafetyCheckStatus: status,
    creatorInstallation: {
      artifactId: 'artifact-one',
      organizationId: 'organization-one',
      slug: 'review-skill',
      version: '1.0.0',
      archiveChecksum: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      installedAt: '2026-07-30T00:00:00.000Z',
      lastKnownStatus: 'active',
      lastCheckedAt: '2026-07-30T12:00:00.000Z',
    },
  }
}

describe('creatorSkillHasStaleSafetyStatus', () => {
  it('propagates a current failed request to list and mention presentation with fresh ledger data', () => {
    const now = Date.parse('2026-07-30T12:01:00.000Z')
    expect(creatorSkillHasStaleSafetyStatus(skill('failed'), now)).toBe(true)
    expect(creatorSkillHasStaleSafetyStatus(skill('ok'), now)).toBe(false)
  })
})
