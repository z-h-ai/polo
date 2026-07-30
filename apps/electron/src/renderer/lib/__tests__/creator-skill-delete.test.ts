import { describe, expect, it, mock } from 'bun:test'
import { deleteWorkspaceSkillWithModifiedConfirmation } from '../creator-skill-delete'

describe('deleteWorkspaceSkillWithModifiedConfirmation', () => {
  it('keeps modified content by default after detaching the Creator record', async () => {
    const creatorSkillUninstall = mock(async () => ({
      success: true as const,
      operationId: crypto.randomUUID(),
    }))
    const result = await deleteWorkspaceSkillWithModifiedConfirmation({
      workspaceId: 'workspace-one',
      slug: 'modified-skill',
      confirmPermanentDelete: () => false,
      api: {
        deleteSkill: async () => ({ managed: true, detached: true }),
        creatorSkillUninstall,
      },
    })

    expect(result).toEqual({ status: 'detached' })
    expect(creatorSkillUninstall).not.toHaveBeenCalled()
  })

  it('uses the explicit forced Creator uninstall from the list entry after secondary confirmation', async () => {
    const creatorSkillUninstall = mock(async (input: {
      workspaceId: string
      operationId: string
      slug: string
      forceDeleteModified?: boolean
    }) => ({
      success: true as const,
      operationId: input.operationId,
    }))
    const result = await deleteWorkspaceSkillWithModifiedConfirmation({
      workspaceId: 'workspace-one',
      slug: 'modified-skill',
      confirmPermanentDelete: () => true,
      api: {
        deleteSkill: async () => ({ managed: true, detached: true }),
        creatorSkillUninstall,
      },
    })

    expect(result).toEqual({ status: 'force_deleted' })
    expect(creatorSkillUninstall).toHaveBeenCalledTimes(1)
    expect(creatorSkillUninstall.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'workspace-one',
      slug: 'modified-skill',
      forceDeleteModified: true,
    })
  })
})
