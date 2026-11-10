/**
 * POO-205 C9 (R12): the notification scope of the workbench bar.
 *
 * While a PROJECT tab is active the notifications are PROJECT-SCOPED — the
 * bell dot and the list count only that project's unread conversations (the
 * workbench lives inside one project at a time; unread from other projects
 * never leaks across). Every other tab — Home, the personal Polo tab,
 * webapps — keeps the workspace-wide list. Pure, so the scope gate and its
 * 反例 stay testable without a TopBar mount.
 */

interface UnreadScopeMeta {
  hasUnread?: boolean | null
  projectId?: string | null
  lastMessageAt?: number | null
}

/** The unread sessions for the notification surface: filtered to the active
 * tab's project when one is active, newest message first. Generic over the
 * caller's meta shape — the filtered list keeps its element type. */
export function projectScopedUnreadSessions<Meta extends UnreadScopeMeta>(
  metas: ReadonlyArray<Meta>,
  activeProjectTabProjectId: string | null,
): Meta[] {
  return metas
    .filter((meta) => meta.hasUnread
      && (!activeProjectTabProjectId || meta.projectId === activeProjectTabProjectId))
    .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
}
