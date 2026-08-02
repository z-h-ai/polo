import { describe, expect, it } from 'bun:test'
import type { LoadedSkill } from '../../../shared/types'
import {
  creatorSkillSafeVersionCandidateKey,
  selectCreatorSkillSafeVersions,
  type CreatorSkillSafeVersionCandidate,
} from '../useCreatorSkillSafetyMonitor'

function loadedCreatorSkill(
  artifactId: string,
  version: string,
): LoadedSkill {
  return {
    slug: 'shared-slug',
    metadata: {
      name: 'Shared Skill',
      description: 'Workspace identity regression fixture.',
    },
    content: 'Instructions.',
    path: '/workspace/skills/shared-slug',
    source: 'workspace',
    creatorInstallation: {
      artifactId,
      organizationId: 'organization-one',
      slug: 'shared-slug',
      version,
      archiveChecksum: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      installedAt: '2026-07-30T00:00:00.000Z',
      lastKnownStatus: 'active',
    },
  }
}

describe('selectCreatorSkillSafeVersions', () => {
  it('does not expose a same-slug candidate after switching workspace or artifact', () => {
    const workspaceOne = 'workspace-one'
    const workspaceTwo = 'workspace-two'
    const candidates: Record<string, CreatorSkillSafeVersionCandidate> = {
      [creatorSkillSafeVersionCandidateKey(
        workspaceOne,
        'artifact-one',
        'shared-slug',
      )]: {
        workspaceId: workspaceOne,
        artifactId: 'artifact-one',
        slug: 'shared-slug',
        version: '2.0.0',
      },
    }

    expect(selectCreatorSkillSafeVersions(
      candidates,
      [loadedCreatorSkill('artifact-one', '1.0.0')],
      workspaceOne,
    )).toEqual({ 'shared-slug': '2.0.0' })

    expect(selectCreatorSkillSafeVersions(
      candidates,
      [loadedCreatorSkill('artifact-two', '1.0.0')],
      workspaceTwo,
    )).toEqual({})

    expect(selectCreatorSkillSafeVersions(
      candidates,
      [loadedCreatorSkill('artifact-two', '1.0.0')],
      workspaceOne,
    )).toEqual({})
  })
})
