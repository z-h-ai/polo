import type { CreatorSkillOperationResult } from '../../shared/types'

export type CreatorSkillDeleteOutcome =
  | { status: 'deleted' }
  | { status: 'detached' }
  | { status: 'force_deleted' }
  | {
      status: 'error'
      result: Extract<CreatorSkillOperationResult, { success: false }>
    }

export async function deleteWorkspaceSkillWithModifiedConfirmation(args: {
  workspaceId: string
  slug: string
  confirmPermanentDelete: () => boolean
  api: Pick<
    Window['electronAPI'],
    'deleteSkill' | 'creatorSkillUninstall'
  >
}): Promise<CreatorSkillDeleteOutcome> {
  const initial = await args.api.deleteSkill({
    workspaceId: args.workspaceId,
    skillSlug: args.slug,
  })
  if (!initial.detached) return { status: 'deleted' }
  if (!args.confirmPermanentDelete()) return { status: 'detached' }
  if (!initial.forceDeleteCredential) {
    return {
      status: 'error',
      result: {
        success: false,
        operationId: crypto.randomUUID(),
        errorCode: 'creator_skill_force_delete_credential_required',
        stage: 'prepare',
        diagnostic: JSON.stringify({
          errorCode: 'creator_skill_force_delete_credential_required',
          stage: 'prepare',
        }),
        retryable: false,
      },
    }
  }

  const forced = await args.api.creatorSkillUninstall({
    workspaceId: args.workspaceId,
    operationId: crypto.randomUUID(),
    slug: args.slug,
    forceDeleteModified: true,
    forceDeleteCredential: initial.forceDeleteCredential,
  })
  if (!forced.success) return { status: 'error', result: forced }
  return { status: 'force_deleted' }
}
