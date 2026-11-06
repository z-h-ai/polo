import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  Loader2,
  Search,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchPrimaryClassName,
} from '@/components/ui/client-workbench'
import { productSpaceAvatarGlyph } from '@/lib/space-initial'
import { cn } from '@/lib/utils'
import type { ClientMemberRole } from '@polo-ai/shared/admin/client-enterprise-contract'
import {
  drawerWidthFor,
  PROJECT_MEMBERS_PANEL_WIDTH,
  type ProjectMembersMode,
} from './project-members-layout'
import { useCollaborationRoster } from './useCollaborationRoster'
import { colleagueProjectStateKeyOf, useProjectColleagues } from './useProjectColleagues'
import {
  COLLEAGUE_COMPOSE_MAX_TARGETS,
  useColleagueInvitations,
  type ColleagueInvitationTargetResult,
} from './useColleagueInvitations'
import { resolveInvitationUrlValue, useProjectMembers } from './useProjectMembers'

/**
 * POO-196 R3 (consensus P8/P9/P10, adjudication D8/D11) — the project
 * members PANEL, the single production members surface. The old centered
 * ProjectMembersDialog is retired: this component owns one content tree that
 * renders into two host forms:
 *
 * - `push`: a non-modal flex sibling of the conversation (no backdrop, the
 *   chat stays interactive); never squeezes the chat below the D8 floor —
 *   the HOST resolves that with resolveProjectMembersMode.
 * - `drawer`: a window-modal overlay (role=dialog/aria-modal, focus trap,
 *   Esc/backdrop/close dismissal) over the suspended native panes.
 *
 * Content (P9): overview = project title + close, server-roster count
 * (totalActiveMembers — never a client-counted or fabricated number), a
 * server-side name search, the shared roster rows (first-letter avatar,
 * display name, role badge, 「我」) and — owner/manager only — the in-panel
 * 添加成员 directory page (multi-select that sends NOTHING until the
 * 「邀请 N 人」 confirm), the per-object invitation results with
 * retry-failed-only recovery, the targeted (phone/email) compose as the
 * secondary path, the invitation records page and the controlled enterprise
 * management handoff. A member sees the same roster with NO management
 * affordances; a roster 403 is a real lost-access state (error + retry),
 * never a success path.
 */

export interface ProjectMembersPanelProps {
  open: boolean
  mode: ProjectMembersMode
  scope: { accountId: string; productSpaceId: string } | null
  projectName: string
  /** The space-summary role — only a fallback while the roster has not
   * spoken yet; the roster's viewerRole is the live authority. */
  viewerRole: ClientMemberRole
  /** The committed project's enterprise id (colleague directory scope
   * consistency only — the server derives the real source per D3). */
  assertedEnterpriseId: string | null
  /** The shared collaboration-roster controller (owned by the host so the
   * header entry and the panel read ONE projection, not two fetchers). */
  roster: ReturnType<typeof useCollaborationRoster>
  onClose: () => void
  onOpenEnterpriseManagement: () => void
}

type PanelPage = 'overview' | 'directory' | 'direct' | 'result' | 'invitations'
type DirectoryView = 'select' | 'colleague-result'

/** True copy state, one colleague at a time (mirrors the single-outcome face
 * of the targeted compose): the last user whose link was copied/failed. */
type ColleagueCopyState = { userId: string; failed: boolean } | null

const LOST_ACCESS_KEY = 'projectMembers.error.lostAccess'

function roleBadgeClass(role: ClientMemberRole): string {
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
  viewerRole: spaceViewerRole,
  assertedEnterpriseId,
  roster,
  onClose,
  onOpenEnterpriseManagement,
}: ProjectMembersPanelProps) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastFocusKeyRef = useRef<string | null>(null)

  const [page, setPage] = useState<PanelPage>('overview')
  const [directoryView, setDirectoryView] = useState<DirectoryView>('select')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [colleagueCopy, setColleagueCopy] = useState<ColleagueCopyState>(null)

  // A roster 403 is a live authority loss (P10): the viewer role goes unknown
  // and every management affordance disappears, whatever the summary said.
  const lostAccess = roster.errorKey === 'projectMembers.error.forbidden'
  const effectiveRole: ClientMemberRole | null = lostAccess
    ? null
    : (roster.viewerRole ?? spaceViewerRole)
  const canManage = effectiveRole === 'owner' || effectiveRole === 'manager'

  const members = useProjectMembers(scope
    ? { accountId: scope.accountId, productSpaceId: scope.productSpaceId, projectName, viewerRole: effectiveRole ?? 'member' }
    : null)
  const colleagues = useProjectColleagues(open && page === 'directory' && scope
    ? { accountId: scope.accountId, productSpaceId: scope.productSpaceId, sourceEnterpriseId: assertedEnterpriseId }
    : null)
  const invites = useColleagueInvitations(open && canManage && scope
    ? { accountId: scope.accountId, productSpaceId: scope.productSpaceId, sourceEnterpriseId: colleagues.source?.enterpriseId ?? null }
    : null)

  // Every open re-enters the overview (fresh data for managers); a MODE
  // switch mid-session must NOT reset anything (D8: 搜索/多选/结果/焦点保留).
  // Managers re-read the invitation records (and this deployment's email
  // capability, which rides the pm roster response and shapes the secondary
  // compose's placeholder). A plain member reads NOTHING here (P10).
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setPage('overview')
      setDirectoryView('select')
      setSelectedIds(new Set())
      setColleagueCopy(null)
      if (canManage) members.openOverview()
    }
    wasOpenRef.current = open
  }) // eslint-disable-line react-hooks/exhaustive-deps -- reads the LATEST canManage/members on the open edge, like the old dialog's openOverview effect

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
   * (focus return is the host's job). An in-flight invitation submit can
   * NEVER be dismissed (X2-4). Every branch stops propagation so the event
   * can never reach the chat's double-Esc interrupt. */
  const stepBack = useCallback(() => {
    if (page === 'direct') {
      members.cancelCompose()
      setPage('overview')
    } else if (page === 'result') {
      members.closeResult()
      setPage('overview')
    } else if (page === 'invitations') {
      setPage('overview')
    } else if (page === 'directory') {
      if (directoryView === 'colleague-result') {
        setDirectoryView('select')
      } else {
        setSelectedIds(new Set())
        setPage('overview')
      }
    } else {
      onClose()
    }
  }, [directoryView, members, onClose, page])

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (members.composeSubmitting || invites.composing) return
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
  }, [invites.composing, members.composeSubmitting, mode, stepBack])

  const handleFocusCapture = useCallback((event: React.FocusEvent) => {
    const key = (event.target as HTMLElement | null)?.getAttribute?.('data-focus-key')
    if (key) lastFocusKeyRef.current = key
  }, [])

  // --- Directory selection -------------------------------------------------

  const selectableMembers = colleagues.members.filter(member => member.projectState === 'available')
  const selectionAtCap = selectedIds.size >= COLLEAGUE_COMPOSE_MAX_TARGETS

  const toggleSelection = useCallback((userId: string, displayName: string | null) => {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(userId)) next.delete(userId)
      else {
        if (next.size >= COLLEAGUE_COMPOSE_MAX_TARGETS) return previous
        next.add(userId)
      }
      return next
    })
  }, [])

  const selectedTargets = colleagues.members
    .filter(member => selectedIds.has(member.userId))
    .map(member => ({ userId: member.userId, displayName: member.displayName }))

  const openDirectory = useCallback(() => {
    setSelectedIds(new Set())
    setDirectoryView('select')
    setPage('directory')
  }, [])

  const openDirectInvite = useCallback(() => {
    members.openCompose()
    setPage('direct')
  }, [members])

  const openInvitations = useCallback(() => {
    members.refreshInvitations()
    setPage('invitations')
  }, [members])

  const submitDirectInvite = useCallback(async () => {
    const ok = await members.submitInvitation()
    if (ok) setPage('result')
  }, [members])

  const confirmColleagueInvitations = useCallback(async () => {
    if (selectedTargets.length === 0) return
    // The confirm ALWAYS lands on the per-object result view — a partial
    // failure is a result too (D5: 逐对象结果保留). Guard rejections (no
    // source) surface through composeErrorKey inside the result view.
    await invites.confirmInvitations(selectedTargets)
    setSelectedIds(new Set())
    setDirectoryView('colleague-result')
  }, [invites, selectedTargets])

  const copyColleagueLink = useCallback(async (result: ColleagueInvitationTargetResult) => {
    if (!result.invitationUrl) return
    setColleagueCopy({ userId: result.userId, failed: false })
    const resolved = await resolveInvitationUrlValue(result.invitationUrl)
    if (!resolved) {
      setColleagueCopy({ userId: result.userId, failed: true })
      return
    }
    try {
      await navigator.clipboard.writeText(resolved)
      setColleagueCopy({ userId: result.userId, failed: false })
    } catch {
      setColleagueCopy({ userId: result.userId, failed: true })
    }
  }, [])

  if (!open) return null

  const directorySourceName = colleagues.source?.name ?? roster.enterpriseName ?? null
  const unresolvedCount = invites.failedCount + invites.pendingCount
  const hasCreated = invites.results.some(result => result.state === 'created' || result.state === 'replayed' || result.state === 'found')

  const panelBody = (
    <>
      {/* Panel header: project name + close (P9), present on every page. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-[14px] py-[10px]">
        {page !== 'overview' ? (
          <button
            type="button"
            data-testid={page === 'directory' && directoryView === 'select' ? 'project-colleagues-back' : 'project-members-compose-back'}
            data-focus-key={page === 'directory' ? 'colleagues-back' : 'compose-back'}
            aria-label={t('projectMembers.invite.backToRoster')}
            disabled={members.composeSubmitting || invites.composing}
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
          {page === 'directory'
            ? t('projectMembers.directory.title')
            : page === 'direct'
              ? t('projectMembers.invite.title')
              : page === 'result'
                ? t('projectMembers.invite.successTitle')
                : page === 'invitations'
                  ? t('projectMembers.invitations.heading')
                  : projectName}
        </h2>
        <button
          type="button"
          data-testid="project-members-close"
          data-focus-key="close"
          aria-label={t('common.close')}
          disabled={members.composeSubmitting || invites.composing}
          onClick={onClose}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground-5 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {/* Overview: the shared roster surface (P9/P10). */}
      {page === 'overview' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[10px] px-[14px] py-[10px]">
          {members.manageErrorKey ? (
            <div
              role="status"
              data-testid="project-members-manage-error"
              className="flex items-start gap-[8px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
            >
              <AlertCircle className="mt-[2px] size-[14px] shrink-0" aria-hidden="true" />
              <span>{t(members.manageErrorKey)}</span>
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
            {!roster.loading && !roster.errorKey && roster.totalActiveMembers !== null ? (
              <span
                className="shrink-0 text-[11px] text-foreground-50"
                data-testid="project-members-roster-count"
              >
                {t('projectMembers.roster.count', { count: roster.totalActiveMembers })}
              </span>
            ) : null}
          </div>

          {roster.loading ? (
            <p
              className="flex items-center gap-[6px] text-[12px] text-muted-foreground"
              data-testid="project-members-roster-loading"
            >
              <Loader2 className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span>{t('projectMembers.loadingMore')}</span>
            </p>
          ) : roster.errorKey ? (
            <div className="flex items-center gap-[10px]" data-testid="project-members-roster-error">
              <p className="text-[12px] text-destructive">
                {/* A roster 403 is a real lost-access state, not a
                    members-only advisory (P10). */}
                {t(roster.errorKey === 'projectMembers.error.forbidden' ? LOST_ACCESS_KEY : roster.errorKey)}
              </p>
              <Button
                type="button"
                variant="ghost"
                className={clientWorkbenchButtonClassName}
                data-testid="project-members-roster-retry"
                onClick={roster.retry}
              >
                {t('projectMembers.retry')}
              </Button>
            </div>
          ) : roster.members.length === 0 ? (
            <p className="text-[12px] text-muted-foreground" data-testid="project-members-roster-empty">
              {roster.query ? t('projectMembers.roster.noMatches') : t('projectMembers.roster.empty')}
            </p>
          ) : (
            <ul
              className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[10px] border border-border"
              data-testid="project-members-roster"
            >
              {roster.members.map(member => (
                <li
                  key={member.userId}
                  data-testid="project-members-roster-row"
                  data-user-id={member.userId}
                  data-member-role={member.role}
                  className="flex items-center gap-[10px] border-b border-border px-[11px] py-[8px] last:border-b-0"
                >
                  <AvatarGlyph name={member.displayName} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                    {member.displayName ?? t('projectMembers.roster.unnamed')}
                  </span>
                  {member.isSelf ? (
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
                </li>
              ))}
            </ul>
          )}

          {roster.nextCursor && !roster.loading && !roster.errorKey ? (
            <Button
              type="button"
              variant="ghost"
              className={clientWorkbenchButtonClassName}
              data-testid="project-members-roster-more"
              disabled={roster.loadingMore}
              onClick={roster.loadMore}
            >
              {roster.loadingMore ? t('projectMembers.loadingMore') : t('projectMembers.loadMore')}
            </Button>
          ) : null}

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
              <div className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  className={clientWorkbenchButtonClassName}
                  data-testid="project-members-invitations-entry"
                  onClick={openInvitations}
                >
                  {t('projectMembers.invitations.heading')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className={clientWorkbenchButtonClassName}
                  data-testid="project-members-open-management"
                  onClick={onOpenEnterpriseManagement}
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  {t('projectMembers.manage.open')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Directory: the in-panel add-member selection page (P9). */}
      {page === 'directory' && directoryView === 'select' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[10px] px-[14px] py-[10px]" data-testid="project-colleagues-page">
          {colleagues.sourceNoticeKey ? (
            <p className="rounded-[10px] bg-foreground-5 px-[12px] py-[10px] text-[12px] leading-[1.55] text-foreground-60" role="status">
              {t(colleagues.sourceNoticeKey)}
            </p>
          ) : colleagues.sourceState === 'available' && directorySourceName ? (
            <p className="text-[12px] leading-[1.55] text-foreground-60">
              {t('projectMembers.directory.source', { enterpriseName: directorySourceName })}
            </p>
          ) : null}

          {colleagues.sourceNoticeKey ? (
            <Button
              type="button"
              className={clientWorkbenchPrimaryClassName}
              data-testid="project-members-direct-invite"
              onClick={openDirectInvite}
            >
              {t('projectMembers.directory.directInvite')}
            </Button>
          ) : null}

          {invites.composeErrorKey ? (
            <p role="alert" className="text-[11px] leading-[1.45] text-destructive" data-testid="project-colleagues-compose-error">
              {t(invites.composeErrorKey)}
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
          ) : colleagues.sourceNoticeKey ? null : (
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

              {colleagues.members.length === 0 ? (
                <p className="text-[12px] text-muted-foreground" data-testid="project-colleagues-empty">
                  {colleagues.query
                    ? t('projectMembers.directory.noMatches')
                    : t('projectMembers.directory.empty')}
                </p>
              ) : (
                <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[10px] border border-border">
                  {colleagues.members.map(member => {
                    const stateKey = colleagueProjectStateKeyOf(member)
                    const selectable = member.projectState === 'available' && !selectionAtCap
                    const selected = selectedIds.has(member.userId)
                    const name = member.displayName ?? t('projectMembers.roster.unnamed')
                    return (
                      <li
                        key={member.userId}
                        data-testid="project-colleagues-row"
                        data-user-id={member.userId}
                        data-project-state={member.projectState}
                        className="flex items-center gap-[10px] border-b border-border px-[11px] py-[8px] last:border-b-0"
                      >
                        <AvatarGlyph name={member.displayName} />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{name}</span>
                        {stateKey ? (
                          <span className="shrink-0 rounded-full bg-foreground-5 px-[7px] py-[1px] text-[11px] leading-[1.6] text-foreground-60">
                            {t(stateKey)}
                          </span>
                        ) : (
                          <button
                            type="button"
                            aria-pressed={selected}
                            aria-label={t('projectMembers.directory.toggleSelection', { name })}
                            disabled={!selectable}
                            onClick={() => toggleSelection(member.userId, member.displayName)}
                            className={cn(
                              'inline-flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent',
                              selected ? 'border-accent bg-accent text-[var(--on-accent,#fff)]' : 'border-border bg-transparent hover:border-foreground/30',
                              !selectable && 'cursor-not-allowed opacity-40',
                            )}
                          >
                            {selected ? <Check className="size-3" aria-hidden="true" /> : null}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {colleagues.nextCursor ? (
                <Button
                  type="button"
                  variant="ghost"
                  className={clientWorkbenchButtonClassName}
                  data-testid="project-colleagues-more"
                  disabled={colleagues.loadingMore}
                  onClick={colleagues.loadMore}
                >
                  {colleagues.loadingMore ? t('projectMembers.loadingMore') : t('projectMembers.loadMore')}
                </Button>
              ) : null}

              {unresolvedCount > 0 ? (
                <div className="flex items-center justify-between gap-2 rounded-[10px] bg-foreground-5 px-[12px] py-[8px]">
                  <span className="text-[11px] leading-[1.45] text-foreground-60">
                    {t('projectMembers.directory.partialFailure')}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    className={clientWorkbenchButtonClassName}
                    data-testid="project-colleagues-retry-failed"
                    disabled={invites.composing}
                    onClick={() => { void invites.retryFailed() }}
                  >
                    {t('projectMembers.directory.retryFailed')}
                  </Button>
                </div>
              ) : null}

              <div className="mt-auto flex shrink-0 items-center justify-between gap-2">
                <span className="text-[12px] text-foreground-60" data-testid="project-colleagues-selected">
                  {t('projectMembers.directory.selected', { count: selectedIds.size })}
                </span>
                <Button
                  type="button"
                  className={clientWorkbenchPrimaryClassName}
                  data-testid="project-colleagues-confirm"
                  data-focus-key="colleagues-confirm"
                  disabled={selectedIds.size === 0 || invites.composing}
                  onClick={() => { void confirmColleagueInvitations() }}
                >
                  {invites.composing
                    ? t('projectMembers.loadingMore')
                    : t('projectMembers.directory.confirm', { count: selectedIds.size })}
                </Button>
              </div>
              {selectionAtCap ? (
                <p className="text-[11px] leading-[1.45] text-foreground-60" role="status">
                  {t('projectMembers.directory.selectionLimit', { max: COLLEAGUE_COMPOSE_MAX_TARGETS })}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* Colleague results: per-object outcomes, retry-failed-only (D5). */}
      {page === 'directory' && directoryView === 'colleague-result' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[10px] px-[14px] py-[10px]">
          <div
            className="flex min-h-0 flex-1 flex-col gap-[8px]"
            data-testid="project-members-invite-result"
            data-scope="colleagues"
            data-created={hasCreated ? 'true' : 'false'}
          >
            <p
              role="status"
              className={cn(
                'rounded-[10px] px-[12px] py-[10px] text-[12px] leading-[1.55]',
                hasCreated ? 'bg-foreground-5 text-foreground-60' : 'bg-[var(--destructive-soft)] text-destructive',
              )}
            >
              {invites.results.length === 0
                ? t(invites.composeErrorKey ?? 'projectMembers.directory.sourceUnavailable')
                : hasCreated
                  ? t('projectMembers.directory.createdPending')
                  : t('projectMembers.directory.partialFailure')}
            </p>
            {hasCreated && invites.failedCount > 0 ? (
              <p role="status" className="text-[11px] leading-[1.45] text-foreground-60">
                {t('projectMembers.directory.partialFailure')}
              </p>
            ) : null}

            <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[10px] border border-border">
              {invites.results.map(result => {
                const name = result.displayName ?? t('projectMembers.roster.unnamed')
                const copiedThis = colleagueCopy?.userId === result.userId && !colleagueCopy.failed
                const copyFailedThis = colleagueCopy?.userId === result.userId && colleagueCopy.failed
                const canQuery = result.state === 'unknown'
                  || (result.state === 'failed' && !result.definiteFailure)
                return (
                  <li
                    key={result.userId}
                    data-user-id={result.userId}
                    {...(result.invitation ? { 'data-invitation-id': result.invitation.invitationId } : {})}
                    className="flex flex-col gap-[4px] border-b border-border px-[11px] py-[8px] last:border-b-0"
                  >
                    <span className="flex items-center gap-[8px]">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{name}</span>
                      {result.state === 'pending' ? (
                        <span className="flex shrink-0 items-center gap-[4px] text-[11px] text-muted-foreground">
                          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                          {t('projectMembers.loadingMore')}
                        </span>
                      ) : result.state === 'failed' && result.errorKey ? (
                        <span className="shrink-0 text-[11px] leading-[1.45] text-destructive" role="alert">
                          {t(result.errorKey)}
                        </span>
                      ) : result.state === 'unknown' ? (
                        <span className="shrink-0 text-[11px] leading-[1.45] text-foreground-60">
                          {t('projectMembers.directory.resultUnknown')}
                        </span>
                      ) : result.state === 'existing' ? (
                        <span className="shrink-0 text-[11px] leading-[1.45] text-foreground-60">
                          {t('projectMembers.invite.existingActive')}
                        </span>
                      ) : result.state === 'state_changed' ? (
                        <span className="shrink-0 text-[11px] leading-[1.45] text-foreground-60">
                          {t('projectMembers.invite.stateChanged')}
                        </span>
                      ) : result.state === 'credential_unrecoverable' ? (
                        <span className="shrink-0 text-[11px] leading-[1.45] text-destructive">
                          {t('projectMembers.invite.linkUnavailable')}
                        </span>
                      ) : result.invitation ? (
                        <span className="shrink-0 rounded-full bg-foreground-5 px-[7px] py-[1px] text-[11px] leading-[1.6] text-foreground-60">
                          {t(members.statusKeyOf(result.invitation.status))}
                        </span>
                      ) : null}
                    </span>
                    {result.invitationUrl ? (
                      <span className="flex items-center gap-[8px]">
                        <Button
                          type="button"
                          className={clientWorkbenchPrimaryClassName}
                          data-testid="project-members-copy-link"
                          data-user-id={result.userId}
                          onClick={() => { void copyColleagueLink(result) }}
                        >
                          {copiedThis ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
                          {copiedThis ? t('projectMembers.invite.copied') : t('projectMembers.invite.copyLink')}
                        </Button>
                        {copyFailedThis ? (
                          <span className="text-[11px] leading-[1.45] text-destructive" role="alert" data-testid="project-members-copy-failed" data-user-id={result.userId}>
                            {t('projectMembers.invite.copyFailed')}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    {canQuery && !invites.composing ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className={clientWorkbenchButtonClassName}
                        data-testid="project-colleagues-query-result"
                        data-user-id={result.userId}
                        disabled={invites.queryingUserId === result.userId}
                        onClick={() => { void invites.queryTarget(result.userId) }}
                      >
                        {t('projectMembers.directory.queryResult')}
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>

          {unresolvedCount > 0 ? (
            <Button
              type="button"
              className={clientWorkbenchPrimaryClassName}
              data-testid="project-colleagues-retry-failed"
              disabled={invites.composing}
              onClick={() => { void invites.retryFailed() }}
            >
              {t('projectMembers.directory.retryFailed')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            className={clientWorkbenchButtonClassName}
            data-testid="project-members-result-back"
            data-focus-key="result-back"
            disabled={invites.composing}
            onClick={() => setDirectoryView('select')}
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            {t('projectMembers.invite.backToRoster')}
          </Button>
        </div>
      ) : null}

      {/* Targeted (phone/email) compose — the secondary path (D11). */}
      {page === 'direct' ? (
        <form
          id="project-invite-form"
          className="flex flex-1 flex-col gap-[10px] px-[14px] py-[10px]"
          data-testid="project-members-compose"
          onSubmit={event => {
            event.preventDefault()
            void submitDirectInvite()
          }}
          noValidate
        >
          <p className="text-[12px] leading-[1.55] text-foreground-60">{t('projectMembers.invite.description')}</p>
          <label className="block">
            <span className="mb-[5px] block text-[12px] font-medium text-foreground">
              {t('projectMembers.invite.targetLabel')}
            </span>
            <Input
              data-testid="project-members-invite-target"
              data-focus-key="invite-target"
              value={members.composeTarget}
              placeholder={t(members.emailDeliveryAvailable
                ? 'projectMembers.invite.targetPlaceholder'
                : 'projectMembers.invite.targetPlaceholderPhone')}
              disabled={members.composeSubmitting}
              onChange={event => members.editComposeTarget(event.target.value)}
              aria-invalid={Boolean(members.composeErrorKey)}
              aria-describedby="project-members-invite-target-error"
            />
            <span
              id="project-members-invite-target-error"
              className="mt-[4px] block text-[11px] leading-[1.45] text-destructive"
              role={members.composeErrorKey ? 'alert' : undefined}
            >
              {members.composeErrorKey ? t(members.composeErrorKey) : ''}
            </span>
          </label>
          <div className="mt-auto flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              className={clientWorkbenchButtonClassName}
              data-testid="project-members-compose-back"
              data-focus-key="compose-back"
              disabled={members.composeSubmitting}
              onClick={stepBack}
            >
              {t('projectMembers.invite.backToRoster')}
            </Button>
            <Button
              type="submit"
              form="project-invite-form"
              className={clientWorkbenchPrimaryClassName}
              data-testid="project-members-invite-submit"
              disabled={members.composeSubmitting}
            >
              {members.composeSubmitting
                ? t('projectMembers.invite.submitting')
                : t('projectMembers.invite.submit')}
            </Button>
          </div>
        </form>
      ) : null}

      {/* Targeted compose result: same outcome union as before (R3 keeps the
          copy/replay/management semantics; D10 rewords the title). */}
      {page === 'result' && members.outcome ? (
        <div
          className="flex flex-1 flex-col gap-[10px] px-[14px] py-[10px]"
          data-testid="project-members-invite-result"
          data-result={members.outcome.result}
        >
          <p className="text-[12px] leading-[1.55] text-foreground-60">{t('projectMembers.invite.successNote')}</p>
          {members.outcome.result === 'credential_unrecoverable' ? (
            <div
              role="status"
              className="rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
              data-testid="project-members-invite-unrecoverable"
            >
              <span>{t('projectMembers.invite.linkUnavailable')}</span>
            </div>
          ) : members.outcome.result === 'state_changed' ? (
            <div
              role="status"
              className="rounded-[10px] bg-foreground-5 px-[12px] py-[10px] text-[12px] leading-[1.55] text-foreground-60"
              data-testid="project-members-invite-state-changed"
            >
              {t('projectMembers.invite.stateChanged')}
            </div>
          ) : members.outcome.result === 'existing' ? (
            <div
              role="status"
              className="rounded-[10px] bg-foreground-5 px-[12px] py-[10px] text-[12px] leading-[1.55] text-foreground-60"
              data-testid="project-members-invite-existing"
            >
              {t('projectMembers.invite.existingActive')}
            </div>
          ) : members.outcome.invitationUrl ? (
            <>
              <Button
                type="button"
                className={clientWorkbenchPrimaryClassName}
                data-testid="project-members-copy-link"
                onClick={() => { void members.copyLink() }}
              >
                {members.copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
                {members.copied ? t('projectMembers.invite.copied') : t('projectMembers.invite.copyLink')}
              </Button>
              {members.copyFailed ? (
                <p className="text-[11px] leading-[1.45] text-destructive" role="alert" data-testid="project-members-copy-failed">
                  {t('projectMembers.invite.copyFailed')}
                </p>
              ) : null}
            </>
          ) : null}
          {members.outcome.result !== 'created' && members.outcome.result !== 'replayed' ? (
            <Button
              type="button"
              variant="ghost"
              className={clientWorkbenchButtonClassName}
              data-testid="project-members-result-management"
              onClick={onOpenEnterpriseManagement}
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              {t('projectMembers.manage.open')}
            </Button>
          ) : null}
          <Button
            type="button"
            className={clientWorkbenchPrimaryClassName}
            data-testid="project-members-result-back"
            data-focus-key="result-back"
            onClick={stepBack}
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            {t('projectMembers.invite.backToRoster')}
          </Button>
        </div>
      ) : null}

      {/* Invitation records — manager-only sub-page (D11 keeps the ids). */}
      {page === 'invitations' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[10px] px-[14px] py-[10px]">
          {members.manageErrorKey ? (
            <p role="status" className="text-[11px] leading-[1.45] text-destructive" data-testid="project-members-manage-error">
              {t(members.manageErrorKey)}
            </p>
          ) : null}
          {members.invitations.loading ? (
            <p className="flex items-center gap-[6px] text-[12px] text-muted-foreground" data-testid="project-members-invitations-loading">
              <Loader2 className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span>{t('projectMembers.loadingMore')}</span>
            </p>
          ) : members.invitations.errorKey ? (
            <div className="flex items-center gap-[10px]" data-testid="project-members-invitations-error">
              <p className="text-[12px] text-destructive">{t(members.invitations.errorKey)}</p>
              <Button
                type="button"
                variant="ghost"
                className={clientWorkbenchButtonClassName}
                data-testid="project-members-invitations-retry"
                onClick={members.retryInvitations}
              >
                {t('projectMembers.retry')}
              </Button>
            </div>
          ) : members.invitations.items.length === 0 ? (
            <p className="text-[12px] text-muted-foreground" data-testid="project-members-invitations-empty">
              {t('projectMembers.invitations.empty')}
            </p>
          ) : (
            <ul
              className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[10px] border border-border"
              data-testid="project-members-invitations"
            >
              {members.invitations.items.map(invitation => {
                const target = invitation.maskedPhone ?? invitation.maskedEmail ?? ''
                return (
                  <li
                    key={invitation.invitationId}
                    data-testid="project-members-invitation-row"
                    data-invitation-status={invitation.status}
                    className="flex flex-col gap-[2px] border-b border-border px-[11px] py-[8px] last:border-b-0"
                  >
                    <span className="flex items-center gap-[8px]">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{target}</span>
                      <span className="shrink-0 rounded-full bg-foreground-5 px-[7px] py-[1px] text-[11px] leading-[1.6] text-foreground-60">
                        {t(members.statusKeyOf(invitation.status))}
                      </span>
                    </span>
                    <span className="text-[11px] leading-[1.45] text-foreground-50">
                      {invitation.acceptedAt
                        ? t('projectMembers.invitations.acceptedAt', { date: new Date(invitation.acceptedAt).toLocaleString() })
                        : t('projectMembers.invitations.expiresAt', { date: new Date(invitation.expiresAt).toLocaleString() })}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {members.invitations.nextCursor ? (
            <Button
              type="button"
              variant="ghost"
              className={clientWorkbenchButtonClassName}
              data-testid="project-members-invitations-more"
              disabled={members.invitations.loadingMore}
              onClick={members.loadMoreInvitations}
            >
              {members.invitations.loadingMore ? t('projectMembers.loadingMore') : t('projectMembers.loadMore')}
            </Button>
          ) : null}
          <p className="mt-auto text-[11px] leading-[1.45] text-foreground-50" data-testid="project-members-manage-note">
            {t('projectMembers.manage.note')}
          </p>
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

/** The header entry「成员 N」(P9): up to three roster avatars ahead of the
 * count; a roster that has not spoken yet degrades to the plain icon + label
 * — never a fabricated 0. Lives in ChatPage/EmptyState header actions. */
export function ProjectMembersEntryLabel({ roster }: { roster: ReturnType<typeof useCollaborationRoster> }) {
  const { t } = useTranslation()
  const members = roster.members.slice(0, 3)
  return (
    <>
      {members.length > 0 ? (
        <span className="flex shrink-0 items-center" aria-hidden="true">
          {members.map(member => (
            <span
              key={member.userId}
              data-user-id={member.userId}
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
    </>
  )
}
