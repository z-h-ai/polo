/**
 * POO-205 C6: session-project binding codes raised at the SESSION layer's own
 * boundary (never returned by the admin wire, so they must not live in a
 * generated contract): an enterprise session must be created inside a project,
 * a personal session must never carry a project binding, and a branch must
 * stay in its source conversation's project. Registered in the transport
 * whitelist through `./types.ts` so the coded-error bridge can carry them to
 * the renderer.
 */

export const SESSION_PROJECT_ERROR_CODES = [
  'PROJECT_CONTEXT_REQUIRED',
  'PROJECT_BINDING_REJECTED_IN_PERSONAL_SPACE',
  'BRANCH_PROJECT_MISMATCH',
] as const
export type SessionProjectErrorCode = (typeof SESSION_PROJECT_ERROR_CODES)[number]

/**
 * Canonical reason text for surfaces WITHOUT the renderer's i18n — the
 * messaging-gateway reply and the automation run record read these. The
 * renderer never renders them directly: it maps the code through its
 * `errors.*` keys so each locale gets its own copy.
 */
export const SESSION_PROJECT_ERROR_MESSAGES: Record<SessionProjectErrorCode, string> = {
  PROJECT_CONTEXT_REQUIRED: '企业空间里的会话需要在项目中创建，请先进入一个项目',
  PROJECT_BINDING_REJECTED_IN_PERSONAL_SPACE: '个人空间不支持项目会话',
  BRANCH_PROJECT_MISMATCH: '不能把会话分支到其他项目',
}
