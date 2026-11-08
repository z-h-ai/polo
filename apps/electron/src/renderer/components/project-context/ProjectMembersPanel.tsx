import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronDown,
  Loader2,
  Search,
  ShieldX,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchDestructiveClassName,
  clientWorkbenchPrimaryClassName,
} from '@/components/ui/client-workbench'
import { productSpaceAvatarGlyph } from '@/lib/space-initial'
import { cn } from '@/lib/utils'
import type { ProjectRole } from '@polo-ai/shared/protocol'
import {
  drawerWidthFor,
  PROJECT_MEMBERS_PANEL_WIDTH,
  type ProjectMembersMode,
} from './project-members-layout'
import type { useCollaborationRoster } from './useCollaborationRoster'
import { useProjectColleagues } from './useProjectColleagues'
import { useProjectMembers } from './useProjectMembers'

/**
 * POO-205 project members PANEL (Spec Q10; rewritten from the POO-196 R3
 * surface — the targeted invitation flow is RETIRED). One content tree that
 * renders into the same two host forms as before:
 *
 * - `push`: a non-modal flex sibling of the conversation (no backdrop, the
 *   chat stays interactive); never squeezes the chat below the D8 floor —
 *   the HOST resolves that with resolveProjectMembersMode.
 * - `drawer`: a window-modal overlay (role=dialog/aria-modal, focus trap,
 *   Esc/backdrop/close dismissal) over the suspended native panes.
 *
 * Content: overview = project title + close, the server member list
 * (`pm:listProjectMembers` — full snapshot, no pagination), a client-side
 * name search, the shared roster rows (first-letter avatar, display name,
 * role badge, 「我」) and — owner/manager only — the in-panel 添加成员
 * directory page: a multi-select over the ORGANIZATION colleague roster
 * (`pm:listOrganizationColleagues`; project members ⊆ organization members,
 * enforced server-side) with one role for the whole batch, submitted as ONE
 * `pm:addProjectMembers` command. Per-row role changes and removal (owner/
 * manager) ride `pm:updateProjectMember` / `pm:removeProjectMember` with
 * their wire errors (`prj_last_owner`…) surfaced in place. A member sees the
 * same roster with NO management affordances; a forbidden read is a real
 * lost-access state (error + retry), never a success path.
 */

export const MEMBER_ADD_MAX_TARGETS = 100

export interface ProjectMembersPanelProps {
  open: boolean
  mode: ProjectMembersMode
  /** The committed-organization PROJECT scope (accountId, org space, org
   * enterprise and the project itself). */
  scope: { accountId: string; productSpaceId: string; organizationEnterpriseId: string; projectId: string } | null
  projectName: string
  /** The shared collaboration-roster controller (owned by the host so the
   * header entry and the panel read ONE projection, not two fetchers). */
  roster: ReturnType<typeof useCollaborationRoster>
  onClose: () => void
  /** Open straight onto the 添加成员 selection page (the one-time onboarding
   * auto-open or the empty-state「添加同事」card). Manager-only; the
   * open-edge effect guards. */
  initialDirectory?: boolean
  /** The one-time onboarding face is active — the panel bottom carries
   * 「先不添加，直接开始」; closing it consumes the offer (host). */
  onboardingOpen?: boolean
}

type PanelPage = 'overview' | 'directory'

const MANAGEABLE_ROLES: ProjectRole[] = ['member', 'manager', 'owner']

const LOST_ACCESS_KEY = 'projectMembers.error.lostAccess'

function roleBadgeClass(role: ProjectRole): string {
  return role === 'owner'
    ? 'bg-[var(--accent-soft)] text-accent'
    : 'bg-foreground-5 text-foreground-60'
}

function AvatarGlyph({ name }: { name: string | null }) {
  const { t } = useTranslation()
  const glyph = productSpaceAvatarGlyph(name || '?', 'enterprise')
  return (
    <span
      className="flex size-[24px] shrink-0 items-center justify-center rounded-[6px] bg-[var(--accent-soft)] text-[11px] font-semibold text-accent"
      aria-hidden="true"
    >
      {glyph.kind === 'letter' ? glyph.letter : t(glyph.key)}
    </span>
  )
}

export function ProjectMembersPanel({
  open,
  mode,
  scope,
  projectName,
  roster,
  onClose,
  initialDirectory = false,
  onboardingOpen = false,
}: ProjectMembersPanelProps) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastFocusKeyRef = useRef<string | null>(null)

  const [page, setPage] = useState<PanelPage>('overview')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [selectedRole, setSelectedRole] = useState<ProjectRole>('member')
  /** Per-command error surface (add / role / remove) inside the panel. */
  const [actionErrorKey, setActionErrorKey] = useState<string | null>(null)
  /** The member row whose role menu is open (one at a time). */
  const [roleMenuFor, setRoleMenuFor] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const scopeKey = scope ? `${scope.accountId}:${scope.projectId}` : null

  const members = useProjectMembers(scope ? {
    accountId: scope.accountId,
    productSpaceId: scope.productSpaceId,
    organizationEnterpriseId: scope.organizationEnterpriseId,
    projectId: scope.projectId,
    // The live authority is the list's own row; the shared roster's derived
    // role only fills in until the list has spoken.
    viewerRoleHint: roster.viewerRole,
  } : null)
  const canManage = members.canManage
  const colleagues = useProjectColleagues(open && page === 'directory' && canManage && scope
    ? {
      accountId: scope.accountId,
      productSpaceId: scope.productSpaceId,
      organizationEnterpriseId: scope.organizationEnterpriseId,
    }
    : null)

  // Every open re-enters the overview (fresh list); a MODE switch mid-session
  // must NOT reset anything (D8: 搜索/多选/焦点保留). An `initialDirectory`
  // open lands straight on the 添加成员 selection page (manager-guarded).
  const wasOpenRef = useRef(false)
  const landingResolvedRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      landingResolvedRef.current = false
      if (canManage && initialDirectory) {
        landingResolvedRef.current = true
        setSelectedIds(new Set())
        setSelectedRole('member')
        setPage('directory')
      } else {
        setPage('overview')
        setSelectedIds(new Set())
        setSelectedRole('member')
      }
      setActionErrorKey(null)
      setRoleMenuFor(null)
      setRemoveTarget(null)
    }
    wasOpenRef.current = open
  }) // eslint-disable-line react-hooks/exhaustive-deps -- reads the LATEST canManage/initialDirectory on the open edge, like the R3 panel's open effect

  // POO-205: the management authority comes from the PROJECT member list,
  // which loads asynchronously — the open edge above can fire before the
  // list has spoken (the live hint may be a stale space-role fallback).
  // While the host asked for the directory landing and the list then grants
  // management, promote once; if the list speaks AGAINST management while
  // the landing page is up, fall back to the honest overview.
  useEffect(() => {
    if (!open) return
    if (page === 'overview' && initialDirectory && canManage && !landingResolvedRef.current) {
      landingResolvedRef.current = true
      setSelectedIds(new Set())
      setSelectedRole('member')
      setPage('directory')
      return
    }
    if (page === 'directory' && !canManage && !members.loading && !members.errorKey) {
      setPage('overview')
    }
  }, [canManage, initialDirectory, members.errorKey, members.loading, open, page])

  // A scope switch resets to the overview and drops every in-page decision.
  useEffect(() => {
    setPage('overview')
    setSelectedIds(new Set())
    setSelectedRole('member')
    setActionErrorKey(null)
    setRoleMenuFor(null)
    setRemoveTarget(null)
  }, [scopeKey])

  // Focus into the panel when it opens; when it closes, the HOST returns
  // focus to the members entry.
  useEffect(() => {
    if (open) {
      const timer = window.setTimeout(() => rootRef.current?.focus(), 0)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [open])

  // Mode switch (push ⇄ drawer): the DOM subtree re-hosts, so restore focus
  // by the stable focus key; a control that no longer exists falls back to
  // the panel close button (D8 切型焦点恢复).
  const previousModeRef = useRef(mode)
  useEffect(() => {
    if (!open) {
      previousModeRef.current = mode
      return
    }
    if (previousModeRef.current === mode) return
    previousModeRef.current = mode
    const key = lastFocusKeyRef.current
    const timer = window.setTimeout(() => {
      const root = rootRef.current
      if (!root) return
      const restore = key ? root.querySelector<HTMLElement>(`[data-focus-key="${key}"]`) : null
      const fallback = root.querySelector<HTMLElement>('[data-testid="project-members-close"]')
      ;(restore ?? fallback ?? root).focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [mode, open])

  /** Sub-page Esc walks one step back; the overview Esc closes the panel
   * (focus return is the host's job). An in-flight mutation cannot be
   * dismissed. Every branch stops propagation so the event can never reach
   * the chat's double-Esc interrupt. */
  const stepBack = useCallback(() => {
    if (page === 'directory') {
      setSelectedIds(new Set())
      setPage('overview')
    } else {
      onClose()
    }
  }, [onClose, page])

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (members.mutating) return
      if (roleMenuFor) {
        setRoleMenuFor(null)
        return
      }
      if (removeTarget) {
        setRemoveTarget(null)
        return
      }
      stepBack()
      return
    }
    if (event.key === 'Tab' && mode === 'drawer') {
      // Drawer focus trap: cycle within the panel (push is non-modal — no trap).
      const root = rootRef.current
      if (!root) return
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
      ))
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement
      const inside = active instanceof Node && root.contains(active)
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault()
          last.focus()
        }
      } else if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }, [members.mutating, mode, removeTarget, roleMenuFor, stepBack])

  const handleFocusCapture = useCallback((event: React.FocusEvent) => {
    const key = (event.target as HTMLElement | null)?.getAttribute?.('data-focus-key')
    if (key) lastFocusKeyRef.current = key
  }, [])

  // --- Member management ---------------------------------------------------

  const memberAccountIds = useMemo(
    () => new Set(members.members.map(member => member.accountId)),
    [members.members],
  )

  // The directory hides colleagues who are ALREADY project members (the
  // server would reject a re-add; the panel simply never offers them).
  const selectableColleagues = useMemo(
    () => colleagues.colleagues.filter(colleague => !memberAccountIds.has(colleague.accountId)),
    [colleagues.colleagues, memberAccountIds],
  )
  const selectionAtCap = selectedIds.size >= MEMBER_ADD_MAX_TARGETS

  const toggleSelection = useCallback((accountId: string) => {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(accountId)) next.delete(accountId)
      else {
        if (next.size >= MEMBER_ADD_MAX_TARGETS) return previous
        next.add(accountId)
      }
      return next
    })
  }, [])

  /** The cap forbids ADDING a 101st target, never CANCELLING a selected row. */
  const rowSelectable = (accountId: string, selected: boolean): boolean =>
    !selectionAtCap || selected

  const openDirectory = useCallback(() => {
    setSelectedIds(new Set())
    setSelectedRole('member')
    setActionErrorKey(null)
    setPage('directory')
  }, [])

  const confirmAddMembers = useCallback(async () => {
    if (!scope || selectedIds.size === 0) return
    const result = await members.addMembers([...selectedIds], selectedRole)
    if (result.ok) {
      setSelectedIds(new Set())
      setSelectedRole('member')
      setActionErrorKey(null)
      setPage('overview')
    } else {
      setActionErrorKey(result.errorKey)
    }
  }, [members, scope, selectedIds, selectedRole])

  const confirmRoleChange = useCallback(async (targetAccountId: string, role: ProjectRole) => {
    setRoleMenuFor(null)
    const result = await members.updateMemberRole(targetAccountId, role)
    setActionErrorKey(result.ok ? null : result.errorKey)
  }, [members])

  const confirmRemove = useCallback(async () => {
    const target = removeTarget
    setRemoveTarget(null)
    if (!target) return
    const result = await members.removeMember(target)
    setActionErrorKey(result.ok ? null : result.errorKey)
  }, [members, removeTarget])

  if (!open) return null

  const panelBody = (
    <>
      {/* Panel header: project name + close (P9), present on every page. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-[14px] py-[10px]">
        {page !== 'overview' ? (
          <button
            type="button"
            data-testid="project-colleagues-back"
            data-focus-key="colleagues-back"
            aria-label={t('projectMembers.invite.backToRoster')}
            disabled={members.mutating}
            onClick={stepBack}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground-5 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
        ) : null}
        <h2
          data-testid="project-members-title"
          className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground"
        >
          {page === 'directory' ? t('projectMembers.directory.title') : projectName}
        </h2>
        <button
          type="button"
          data-testid="project-members-close"
          data-focus-key="close"
          aria-label={t('common.close')}
          disabled={members.mutating}
          onClick={onClose}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground-5 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {/* Overview: the member list (P9/P10, POO-205 contract). */}
      {page === 'overview' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[10px] px-[14px] py-[10px]">
          {members.lostAccess ? (
            <div
              role="status"
              data-testid="project-members-manage-error"
              className="flex items-start gap-[8px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
            >
              <AlertCircle className="mt-[2px] size-[14px] shrink-0" aria-hidden="true" />
              <span>{t(LOST_ACCESS_KEY)}</span>
            </div>
          ) : actionErrorKey ? (
            <div
              role="alert"
              data-testid="project-members-action-error"
              className="flex items-start gap-[8px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
            >
              <AlertCircle className="mt-[2px] size-[14px] shrink-0" aria-hidden="true" />
              <span>{t(actionErrorKey)}</span>
            </div>
          ) : null}

          <div className="flex shrink-0 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                data-testid="project-members-search"
                data-focus-key="roster-search"
                value={roster.query}
                placeholder={t('projectMembers.roster.searchPlaceholder')}
                disabled={roster.errorKey != null}
                onChange={event => roster.search(event.target.value)}
                className="h-8 pl-7 text-[12px]"
              />
            </div>
            {!members.loading && !members.errorKey ? (
              <span
                className="shrink-0 text-[11px] text-foreground-50"
                data-testid="project-members-roster-count"
              >
                {t('projectMembers.roster.count', { count: members.members.length })}
              </span>
            ) : null}
          </div>

          {members.loading ? (
            <p
              className="flex items-center gap-[6px] text-[12px] text-muted-foreground"
              data-testid="project-members-roster-loading"
            >
              <Loader2 className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span>{t('projectMembers.loadingMore')}</span>
            </p>
          ) : members.errorKey ? (
            <div className="flex items-center gap-[10px]" data-testid="project-members-roster-error">
              <p className="text-[12px] text-destructive">
                {/* A forbidden read is a real lost-access state, not a
                    members-only advisory (P10). */}
                {t(members.errorKey === 'projectMembers.error.forbidden' ? LOST_ACCESS_KEY : members.errorKey)}
              </p>
              <Button
                type="button"
                variant="ghost"
                className={clientWorkbenchButtonClassName}
                data-testid="project-members-roster-retry"
                onClick={members.reload}
              >
                {t('projectMembers.retry')}
              </Button>
            </div>
          ) : members.members.length === 0 ? (
            <p className="text-[12px] text-muted-foreground" data-testid="project-members-roster-empty">
              {roster.query ? t('projectMembers.roster.noMatches') : t('projectMembers.roster.empty')}
            </p>
          ) : (
            <ul
              className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[10px] border border-border"
              data-testid="project-members-roster"
            >
              {members.members.map(member => {
                const isSelf = member.accountId === scope?.accountId
                const roleMenuOpen = roleMenuFor === member.accountId
                return (
                  <li
                    key={member.accountId}
                    data-testid="project-members-roster-row"
                    data-account-id={member.accountId}
                    data-member-role={member.role}
                    className="border-b border-border last:border-b-0"
                  >
                    <div className="flex items-center gap-[10px] px-[11px] py-[8px]">
                      <AvatarGlyph name={member.displayName} />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                        {member.displayName ?? t('projectMembers.roster.unnamed')}
                      </span>
                      {isSelf ? (
                        <span
                          className="shrink-0 rounded-full bg-[var(--accent-soft)] px-[7px] py-[1px] text-[11px] leading-[1.6] text-accent"
                          data-testid="project-members-roster-me"
                        >
                          {t('projectMembers.roster.me')}
                        </span>
                      ) : null}
                      <span className={cn('shrink-0 rounded-full px-[7px] py-[1px] text-[11px] leading-[1.6]', roleBadgeClass(member.role))}>
                        {t(`projectMembers.role.${member.role}`)}
                      </span>
                      {canManage && !isSelf ? (
                        <button
                          type="button"
                          data-testid="project-members-row-manage"
                          data-account-id={member.accountId}
                          aria-label={t('poo205.members.manageMember', { name: member.displayName ?? t('projectMembers.roster.unnamed') })}
                          aria-haspopup="menu"
                          aria-expanded={roleMenuOpen}
                          onClick={() => setRoleMenuFor(open => (open === member.accountId ? null : member.accountId))}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground-5 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                        >
                          <ChevronDown className="size-3.5" aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                    {roleMenuOpen ? (
                      <div
                        role="menu"
                        data-testid="project-members-role-menu"
                        data-account-id={member.accountId}
                        className="flex flex-col gap-[2px] border-t border-border bg-foreground-5 px-[11px] py-[8px]"
                      >
                        {MANAGEABLE_ROLES.map(role => (
                          <button
                            key={role}
                            type="button"
                            role="menuitem"
                            data-testid="project-members-role-option"
                            data-role={role}
                            aria-current={member.role === role || undefined}
                            disabled={members.mutating || member.role === role}
                            onClick={() => { void confirmRoleChange(member.accountId, role) }}
                            className={cn(
                              'flex min-h-[28px] items-center justify-between gap-[8px] rounded-[6px] px-[8px] text-left text-[12px] text-foreground transition-colors hover:bg-foreground-10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent',
                              member.role === role && 'font-semibold text-accent',
                            )}
                          >
                            <span>{t(`projectMembers.role.${role}`)}</span>
                            {member.role === role ? <Check className="size-3 text-accent" aria-hidden="true" /> : null}
                          </button>
                        ))}
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="project-members-remove-option"
                          disabled={members.mutating}
                          onClick={() => {
                            setRoleMenuFor(null)
                            setRemoveTarget(member.accountId)
                          }}
                          className="mt-[2px] flex min-h-[28px] items-center gap-[8px] rounded-[6px] px-[8px] text-left text-[12px] text-destructive transition-colors hover:bg-[var(--destructive-soft)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                        >
                          <ShieldX className="size-3.5" aria-hidden="true" />
                          {t('poo205.members.removeAction')}
                        </button>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}

          {canManage ? (
            <div className="mt-auto flex shrink-0 flex-col gap-[8px]">
              <Button
                type="button"
                className={clientWorkbenchPrimaryClassName}
                data-testid="project-members-invite-action"
                data-focus-key="invite-action"
                onClick={openDirectory}
              >
                <UserPlus className="size-3.5" aria-hidden="true" />
                {t('projectMembers.invite.action')}
              </Button>
              <p className="m-0 text-[11px] leading-[1.45] text-foreground-50">
                {t('poo205.members.rosterNote')}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Directory: the in-panel add-member selection page (Q10 — picked from
          the ORGANIZATION roster, one role for the batch, ONE command). */}
      {page === 'directory' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[10px] px-[14px] py-[10px]" data-testid="project-colleagues-page">
          {actionErrorKey ? (
            <p role="alert" className="text-[11px] leading-[1.45] text-destructive" data-testid="project-colleagues-compose-error">
              {t(actionErrorKey)}
            </p>
          ) : null}

          {colleagues.loading ? (
            <p className="flex items-center gap-[6px] text-[12px] text-muted-foreground" data-testid="project-colleagues-loading">
              <Loader2 className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span>{t('projectMembers.directory.loading')}</span>
            </p>
          ) : colleagues.errorKey ? (
            <div className="flex items-center gap-[10px]" data-testid="project-colleagues-error">
              <p className="text-[12px] text-destructive">{t(colleagues.errorKey)}</p>
              <Button
                type="button"
                variant="ghost"
                className={clientWorkbenchButtonClassName}
                data-testid="project-colleagues-retry"
                onClick={colleagues.retry}
              >
                {t('projectMembers.retry')}
              </Button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  data-testid="project-colleagues-search"
                  data-focus-key="colleagues-search"
                  value={colleagues.query}
                  placeholder={t('projectMembers.directory.searchPlaceholder')}
                  onChange={event => colleagues.search(event.target.value)}
                  className="h-8 pl-7 text-[12px]"
                />
              </div>

              {selectableColleagues.length === 0 ? (
                <p className="text-[12px] text-muted-foreground" data-testid="project-colleagues-empty">
                  {colleagues.query
                    ? t('projectMembers.directory.noMatches')
                    : t('projectMembers.directory.empty')}
                </p>
              ) : (
                <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[10px] border border-border">
                  {selectableColleagues.map(colleague => {
                    const selected = selectedIds.has(colleague.accountId)
                    const selectable = rowSelectable(colleague.accountId, selected)
                    const name = colleague.displayName ?? t('projectMembers.roster.unnamed')
                    // ONE row-wide native button owns the whole selectable row
                    // (avatar/name/checkbox are ITS content — never nested
                    // interactive elements).
                    return (
                      <li
                        key={colleague.accountId}
                        data-testid="project-colleagues-row"
                        data-account-id={colleague.accountId}
                        className="border-b border-border last:border-b-0"
                      >
                        <button
                          type="button"
                          data-testid="project-colleagues-row-toggle"
                          aria-pressed={selected}
                          aria-label={t('projectMembers.directory.toggleSelection', { name })}
                          disabled={!selectable}
                          onClick={() => toggleSelection(colleague.accountId)}
                          className={cn(
                            'flex w-full items-center gap-[10px] rounded-none px-[11px] py-[8px] text-left transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent',
                            selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-foreground-5',
                            !selectable && 'cursor-not-allowed opacity-40',
                          )}
                        >
                          <AvatarGlyph name={colleague.displayName} />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{name}</span>
                          <span
                            aria-hidden="true"
                            className={cn(
                              'inline-flex size-[24px] shrink-0 items-center justify-center rounded-[6px] border transition-colors',
                              selected ? 'border-accent bg-accent text-[var(--on-accent,#fff)]' : 'border-border bg-transparent',
                            )}
                          >
                            {selected ? <Check className="size-3.5" /> : null}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}

              <label className="flex shrink-0 items-center gap-[8px] text-[12px] text-foreground-60">
                <span className="shrink-0">{t('poo205.members.batchRoleLabel')}</span>
                <select
                  data-testid="project-colleagues-role-select"
                  data-focus-key="colleagues-role"
                  value={selectedRole}
                  disabled={members.mutating}
                  onChange={event => setSelectedRole(event.target.value as ProjectRole)}
                  className="h-8 min-w-0 flex-1 rounded-[8px] border border-border bg-surface px-[8px] text-[12px] text-foreground outline-none focus-visible:border-accent"
                >
                  {MANAGEABLE_ROLES.map(role => (
                    <option key={role} value={role}>{t(`projectMembers.role.${role}`)}</option>
                  ))}
                </select>
              </label>

              <div className="mt-auto flex shrink-0 items-center justify-between gap-2">
                <span className="text-[12px] text-foreground-60" data-testid="project-colleagues-selected">
                  {t('projectMembers.directory.selected', { count: selectedIds.size })}
                </span>
                <Button
                  type="button"
                  className={clientWorkbenchPrimaryClassName}
                  data-testid="project-colleagues-confirm"
                  data-focus-key="colleagues-confirm"
                  disabled={selectedIds.size === 0 || members.mutating}
                  onClick={() => { void confirmAddMembers() }}
                >
                  {members.mutating
                    ? t('projectMembers.loadingMore')
                    : t('poo205.members.confirmAdd', { count: selectedIds.size })}
                </Button>
              </div>
              {selectionAtCap ? (
                <p className="text-[11px] leading-[1.45] text-foreground-60" role="status">
                  {t('projectMembers.directory.selectionLimit', { max: MEMBER_ADD_MAX_TARGETS })}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* Removal confirmation — an explicit destructive step, never a
          one-click row action (the wire's prj_last_owner still answers). */}
      {removeTarget ? (
        <div
          role="alertdialog"
          aria-label={t('poo205.members.removeConfirmTitle')}
          data-testid="project-members-remove-confirm"
          className="flex flex-col gap-[10px] border-t border-border px-[14px] py-[12px]"
        >
          <p className="m-0 text-[12px] leading-[1.55] text-foreground">
            {t('poo205.members.removeConfirmBody', {
              name: members.members.find(member => member.accountId === removeTarget)?.displayName
                ?? t('projectMembers.roster.unnamed'),
            })}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              className={clientWorkbenchButtonClassName}
              data-testid="project-members-remove-cancel"
              disabled={members.mutating}
              onClick={() => setRemoveTarget(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              className={clientWorkbenchDestructiveClassName}
              data-testid="project-members-remove-confirm-action"
              disabled={members.mutating}
              onClick={() => { void confirmRemove() }}
            >
              {t('poo205.members.removeAction')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* One-time onboarding face — 「先不添加，直接开始」 at the panel bottom.
          Closing via this button (like X/backdrop/Esc) lands in the host's
          closePanel, which consumes the offer and refocuses the composer;
          nothing is added, created or sent along the whole path. */}
      {onboardingOpen && canManage ? (
        <div
          className="flex shrink-0 items-center justify-center border-t border-border px-[14px] py-[10px]"
          data-testid="project-onboarding-skip-bar"
        >
          <Button
            type="button"
            variant="ghost"
            className={clientWorkbenchButtonClassName}
            data-testid="project-onboarding-skip"
            onClick={onClose}
          >
            {t('project.entry.skipInvite')}
          </Button>
        </div>
      ) : null}
    </>
  )

  if (mode === 'drawer') {
    // True window modal: the overlay is portaled to the body so it can cover
    // the whole window (the native panes are IPC-suspended by the host).
    const viewportWidth = typeof window === 'undefined' ? PROJECT_MEMBERS_PANEL_WIDTH : window.innerWidth
    return createPortal(
      <div
        ref={rootRef}
        data-testid="project-members-panel"
        data-mode="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={projectName}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onFocusCapture={handleFocusCapture}
        className="fixed inset-0 z-modal flex justify-end outline-none"
      >
        <div
          aria-hidden="true"
          data-testid="project-members-backdrop"
          className="absolute inset-0 bg-[var(--overlay,rgba(0,0,0,0.5))]"
          onClick={onClose}
        />
        <div
          className="relative flex min-h-0 flex-col border-l border-border bg-background shadow-lg"
          style={{ width: drawerWidthFor(viewportWidth) }}
        >
          {panelBody}
        </div>
      </div>,
      document.body,
    )
  }

  // Push: a plain flex sibling — the conversation stays interactive.
  return (
    <aside
      ref={rootRef}
      data-testid="project-members-panel"
      data-mode="push"
      aria-label={projectName}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onFocusCapture={handleFocusCapture}
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-border bg-background outline-none"
      style={{ width: PROJECT_MEMBERS_PANEL_WIDTH }}
    >
      {panelBody}
    </aside>
  )
}

/** The header entry「成员 N」(P9, U7 button): up to three roster avatars ahead
 * of the count, a trailing add-member glyph for owner/manager (aria-hidden —
 * the WHOLE button is the one target and its accessible name carries the
 * add capability, never the glyph alone); a roster that has not spoken yet
 * degrades to the plain icon + label — never a fabricated 0. Lives in
 * ChatPage/EmptyState header actions. */
export function ProjectMembersEntryLabel({ roster, showInviteAffordance = false }: {
  roster: ReturnType<typeof useCollaborationRoster>
  showInviteAffordance?: boolean
}) {
  const { t } = useTranslation()
  const members = roster.members.slice(0, 3)
  return (
    <>
      {members.length > 0 ? (
        <span className="flex shrink-0 items-center" aria-hidden="true">
          {members.map(member => (
            <span
              key={member.accountId}
              data-user-id={member.accountId}
              className="flex size-[18px] items-center justify-center rounded-full border border-background bg-[var(--accent-soft)] text-[9px] font-semibold text-accent"
              style={{ marginLeft: -6 }}
            >
              {(() => {
                const glyph = productSpaceAvatarGlyph(member.displayName || '?', 'enterprise')
                return glyph.kind === 'letter' ? glyph.letter : t(glyph.key)
              })()}
            </span>
          ))}
        </span>
      ) : (
        <Users className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">
        {roster.totalActiveMembers !== null
          ? t('projectMembers.entryCount', { count: roster.totalActiveMembers })
          : t('projectMembers.buttonLabel')}
      </span>
      {showInviteAffordance ? (
        <UserPlus className="size-3.5 shrink-0" aria-hidden="true" data-testid="pc-members-entry-plus" />
      ) : null}
    </>
  )
}
