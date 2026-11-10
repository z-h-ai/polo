/**
 * POO-205 C6: session-project binding codes raised at the SESSION layer's own
 * boundary (never returned by the admin wire, so they must not live in a
 * generated contract): an enterprise session must be created inside a project,
 * a personal session must never carry a project binding, and a branch must
 * stay in its source conversation's project. Registered in the transport
 * whitelist through `./types.ts` so the coded-error bridge can carry them to
 * the renderer.
 *
 * POO-205 C7a adds PROJECT_CONTEXT_UNAVAILABLE: the server could not re-prove
 * the caller's membership in the project (network/5xx/timeout/no session) —
 * creation refuses rather than trusting the renderer-supplied snapshot.
 *
 * POO-205 C7b adds ENTERPRISE_PERSONAL_CONTEXT_BLOCKED: an enterprise session
 * never touches personal scope — working directory (workspace default or
 * caller-supplied), AGENTS.md/CLAUDE.md discovery, personal data sources and
 * personal Skills are all out of reach. Mutating RPCs that would attach any
 * of those (updateWorkingDirectory, setSources) refuse with this code.
 */
export const SESSION_PROJECT_ERROR_CODES = [
  'PROJECT_CONTEXT_REQUIRED',
  'PROJECT_BINDING_REJECTED_IN_PERSONAL_SPACE',
  'BRANCH_PROJECT_MISMATCH',
  'PROJECT_CONTEXT_UNAVAILABLE',
  'ENTERPRISE_PERSONAL_CONTEXT_BLOCKED',
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
  PROJECT_CONTEXT_UNAVAILABLE: '暂时无法确认项目信息，请检查网络后重试',
  ENTERPRISE_PERSONAL_CONTEXT_BLOCKED: '企业空间的会话不能使用个人工作目录或数据源',
}
