import { CodedError, SESSION_PROJECT_ERROR_MESSAGES } from '@polo-ai/shared/protocol'

/**
 * POO-205 C6: the ONE project-binding gate behind every session-creating
 * surface — chat creation, branching (after the branch inherited its source's
 * binding), agent spawn, import, automation and remote transfer. An
 * enterprise session MUST carry the project binding; a personal session must
 * never have one. The caller-supplied projectId is a routing/consistency
 * assertion, not an authorization grant — membership is admin-proven where
 * the project is resolved (project-context send path, member RPCs). C7a adds
 * member validation HERE so every creation surface is covered at once.
 *
 * Without a committed ProductSpace the gate is inert (legacy/headless
 * personal workspaces keep creating plain sessions — the CLI path is
 * unchanged).
 */
export function assertSessionProjectBinding(input: {
  /** A committed ProductSpace is present (`trustedScope?.productSpaceId`). */
  hasCommittedProductSpace: boolean
  /** The committed space kind at creation time. */
  activeSpaceKind: 'personal' | 'enterprise' | null
  /** The caller-supplied (or branch-inherited) project binding. */
  projectId?: string | null
}): void {
  if (!input.hasCommittedProductSpace) return
  if (input.activeSpaceKind === 'enterprise' && !input.projectId) {
    throw new CodedError('PROJECT_CONTEXT_REQUIRED', SESSION_PROJECT_ERROR_MESSAGES.PROJECT_CONTEXT_REQUIRED)
  }
  if (input.activeSpaceKind !== 'enterprise' && input.projectId) {
    throw new CodedError('PROJECT_BINDING_REJECTED_IN_PERSONAL_SPACE', SESSION_PROJECT_ERROR_MESSAGES.PROJECT_BINDING_REJECTED_IN_PERSONAL_SPACE)
  }
}

/** The immutable project binding a created/imported session carries: only a
 * session the server itself binds to an enterprise space is project-bound. */
export function resolveSessionProjectBinding(input: {
  hasCommittedProductSpace: boolean
  activeSpaceKind: 'personal' | 'enterprise' | null
  projectId?: string | null
}): string | undefined {
  return input.hasCommittedProductSpace && input.activeSpaceKind === 'enterprise'
    ? (input.projectId ?? undefined)
    : undefined
}
