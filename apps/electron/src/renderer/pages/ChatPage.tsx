/**
 * ChatPage
 *
 * Displays a single session's chat with a consistent PanelHeader.
 * Extracted from MainContentPanel for consistency with other pages.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { i18n } from '@polo-ai/shared/i18n'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { AlertCircle, Focus, Globe, Copy, RefreshCw, Link2Off, Info } from 'lucide-react'
import { ChatDisplay, type ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { SessionMenu } from '@/components/app-shell/SessionMenu'
import { CompactSessionMenu } from '@/components/app-shell/CompactSessionMenu'
import { SessionInfoPopover } from '@/components/app-shell/SessionInfoPopover'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { toast } from 'sonner'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator } from '@/components/ui/styled-dropdown'
import { useAppShellContext, usePendingPermission, usePendingCredential, usePendingQuestion, useSessionOptionsFor, useSession as useSessionData } from '@/context/AppShellContext'
import { rendererPerf } from '@/lib/perf'
import { routes } from '@/lib/navigate'
import { coerceInputText } from '@/lib/input-text'
import { deriveSessionMessagesLoadState, formatSessionLoadFailure } from '@/lib/session-load'
import { decideChatAccessBanner } from '@/lib/chat-access-banner'
import { createCitationSourceOpener, type CitationSourceScope } from '@/lib/open-citation-source'
import { formatQuotaResetTime } from '@/lib/quota-reset-time'
import { useAdminPaymentHandoff } from '@/hooks/useAdminPaymentHandoff'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { useOptionalActionRegistry } from '@/actions'
import { workbenchFocusModeAtom } from '@/atoms/workbench-view'
import { ensureSessionMessagesLoadedAtom, forceSessionMessagesReloadAtom, loadedSessionsAtom, sendFailureAtomFamily, sessionMetaMapAtom } from '@/atoms/sessions'
import { elementDraftRefsAtomFamily } from '@/atoms/sidebar-browser'
import { projectAssetDraftRefsAtomFamily, type ProjectAssetMentionDraft } from '@/atoms/project-context'
import { ProjectContextTabs, type ProjectContextTab } from '@/components/project-context/ProjectContextTabs'
import { ProjectFileLibrary } from '@/components/project-context/ProjectFileLibrary'
import { ProjectPinPane } from '@/components/project-context/ProjectPinPane'
import { ShareToProjectDialog, type ShareToProjectTarget } from '@/components/project-context/ShareToProjectDialog'
import { ProjectMembersEntryLabel, ProjectMembersPanel } from '@/components/project-context/ProjectMembersPanel'
import { useProjectMembersPanelHost } from '@/components/project-context/useProjectMembersPanelHost'
import { useCollaborationRoster } from '@/components/project-context/useCollaborationRoster'
import { useRightPanePresentation } from '@/hooks/use-right-pane-presentation'
import { canvasPaneAppAtomFamily, canvasPanePopoutAtomFamily } from '@/atoms/canvas-pane'
import { useProjectEntryPending } from '@/hooks/useProjectEntry'
import { projectEntryAtom, projectEntrySendNoticesAtom, isEntryPendingState } from '@/atoms/project-entry'
import { createEnterpriseWorkflowUrl } from '@/lib/enterprise-workflow-url'
import { dispatchFocusInputEvent } from '@/components/app-shell/input/focus-input-events'
import { getSessionTitle } from '@/utils/session'
// Model resolution: connection.defaultModel (no hardcoded defaults)
import { resolveEffectiveConnectionSlug, isSessionConnectionUnavailable } from '@config/llm-connections'

export interface ChatPageProps {
  sessionId: string
}

/**
 * POO-179: the self-produced "no messages" failure is stored verbatim in
 * state and only resolved to display copy at render time, so an error visible
 * across a language switch re-renders in the active language. Raw server
 * error strings (formatSessionLoadFailure) pass through untouched.
 */
const MESSAGES_UNAVAILABLE_SENTINEL = 'Session messages are not available'

const ChatPage = React.memo(function ChatPage({ sessionId }: ChatPageProps) {
  const { t } = useTranslation()
  // Diagnostic: mark when component runs
  React.useLayoutEffect(() => {
    rendererPerf.markSessionSwitch(sessionId, 'panel.mounted')
  }, [sessionId])

  // Journey #1: the insufficient-credit banner's recharge action reuses the
  // SAME trusted handoff as the TopBar (one-at-a-time, scope-fenced); the
  // member variant is decided by the shared role gate.
  const productSpace = useOptionalProductSpaceContext()
  const { canOpenPayment, openPayment } = useAdminPaymentHandoff()

  const {
    activeWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    chatAccessStatus,
    onRetryAiConfigSync,
    onRecheckBilling,
    billingRecheckPending,
    onSendMessage,
    onOpenFile,
    onOpenUrl,
    workspaces,
    onRespondToPermission,
    onRespondToCredential,
    onRespondToQuestion,
    onMarkSessionRead,
    onMarkSessionUnread,
    onSetActiveViewingSession,
    getDraft,
    hydrateDraftAttachments,
    onInputChange,
    onAttachmentsChange,
    enabledSources,
    skills,
    labels,
    onSessionLabelsChange,
    enabledModes,
    sessionStatuses,
    onSessionSourcesChange,
    onRenameSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onSessionStatusChange,
    onDeleteSession,
    rightSidebarButton,
    leadingAction,
    isCompactMode,
    sessionListSearchQuery,
    isSearchModeActive,
    chatDisplayRef,
    onChatMatchInfoChange,
    isFocusedPanel,
    filePreview,
    filePreviewVisible,
  } = useAppShellContext()

  // Use the unified session options hook for clean access
  const {
    options: sessionOpts,
    setPermissionMode,
  } = useSessionOptionsFor(sessionId)

  // Use per-session atom for isolated updates
  const session = useSessionData(sessionId)

  // Track if messages are loaded for this session (for lazy loading)
  const loadedSessions = useAtomValue(loadedSessionsAtom)
  const messagesLoaded = loadedSessions.has(sessionId)

  // Check if session exists in metadata (for loading state detection)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMeta = sessionMetaMap.get(sessionId)

  // Fallback: ensure messages are loaded when session is viewed
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)
  const forceMessagesReload = useSetAtom(forceSessionMessagesReloadAtom)
  const [messagesLoadError, setMessagesLoadError] = React.useState<string | null>(null)
  const [messagesRetrying, setMessagesRetrying] = React.useState(false)
  const autoForcedReloadSessionRef = React.useRef<string | null>(null)
  const shouldForceInitialMessagesReload = React.useMemo(() => {
    const expectedMessageCount = session?.messageCount ?? sessionMeta?.messageCount ?? 0
    return messagesLoaded
      && !!session
      && (session.messages?.length ?? 0) === 0
      && (expectedMessageCount > 0 || !!session.lastFinalMessageId || !!sessionMeta?.lastFinalMessageId)
  }, [messagesLoaded, session, sessionMeta])

  React.useEffect(() => {
    let cancelled = false
    setMessagesLoadError(null)
    setMessagesRetrying(false)

    if (shouldForceInitialMessagesReload && autoForcedReloadSessionRef.current === sessionId) {
      setMessagesLoadError(MESSAGES_UNAVAILABLE_SENTINEL)
      return () => {
        cancelled = true
      }
    }

    const useForceReload = shouldForceInitialMessagesReload
    if (useForceReload) {
      autoForcedReloadSessionRef.current = sessionId
    }

    const loadPromise = useForceReload
      ? forceMessagesReload(sessionId)
      : ensureMessagesLoaded(sessionId)

    loadPromise
      .then((loadedSession) => {
        if (!cancelled && !loadedSession) {
          setMessagesLoadError(MESSAGES_UNAVAILABLE_SENTINEL)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessagesLoadError(formatSessionLoadFailure(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [sessionId, ensureMessagesLoaded, forceMessagesReload, shouldForceInitialMessagesReload])

  const handleRetryMessagesLoad = React.useCallback(async () => {
    setMessagesLoadError(null)
    setMessagesRetrying(true)

    try {
      const loadedSession = await forceMessagesReload(sessionId)
      if (!loadedSession) {
        setMessagesLoadError(MESSAGES_UNAVAILABLE_SENTINEL)
      }
    } catch (error) {
      setMessagesLoadError(formatSessionLoadFailure(error))
    } finally {
      setMessagesRetrying(false)
    }
  }, [forceMessagesReload, sessionId])

  const messageLoadState = React.useMemo(() => deriveSessionMessagesLoadState({
    session,
    sessionMeta,
    messagesLoaded,
    loadError: messagesLoadError,
  }), [session, sessionMeta, messagesLoaded, messagesLoadError])

  // Perf: Mark when session data is available
  const sessionLoadedMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (session && sessionLoadedMarkedRef.current !== sessionId) {
      sessionLoadedMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
    }
  }, [sessionId, session])

  // Track window focus state for marking session as read when app regains focus
  const [isWindowFocused, setIsWindowFocused] = React.useState(true)
  React.useEffect(() => {
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)
    const cleanup = window.electronAPI.onWindowFocusChange(setIsWindowFocused)
    return cleanup
  }, [])

  // Track which session user is viewing (for unread state machine).
  // This tells main process user is looking at this session, so:
  // 1. If not processing → clear hasUnread immediately
  // 2. If processing → when it completes, main process will clear hasUnread
  // The main process handles all the logic; we just report viewing state.
  React.useEffect(() => {
    if (session && isWindowFocused && isFocusedPanel !== false) {
      onSetActiveViewingSession(session.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, isWindowFocused, isFocusedPanel, onSetActiveViewingSession])

  // Get pending permission and credential for this session
  const pendingPermission = usePendingPermission(sessionId)
  const pendingCredential = usePendingCredential(sessionId)
  const pendingQuestion = usePendingQuestion(sessionId)

  // Track draft value for this session
  const [inputValue, setInputValue] = React.useState(() => coerceInputText(getDraft(sessionId)))
  const inputValueRef = React.useRef(inputValue)
  inputValueRef.current = inputValue

  // Re-sync from parent when session changes
  React.useEffect(() => {
    setInputValue(coerceInputText(getDraft(sessionId)))
  }, [getDraft, sessionId])

  // Sync when draft is set externally (e.g., from notifications or shortcuts)
  // PERFORMANCE NOTE: This bounded polling (max 10 attempts × 50ms = 500ms)
  // handles external draft injection. Drafts use a ref for typing performance,
  // so they're not directly reactive. This polling only runs on session switch,
  // not continuously. Alternative: Add a Jotai atom for draft changes.
  React.useEffect(() => {
    let attempts = 0
    const maxAttempts = 10
    const interval = setInterval(() => {
      const currentDraft = coerceInputText(getDraft(sessionId))
      if (currentDraft !== inputValueRef.current && currentDraft !== '') {
        setInputValue(currentDraft)
        clearInterval(interval)
      }
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 50)

    return () => clearInterval(interval)
  }, [sessionId, getDraft])

  // Listen for restore-input events (queued messages restored to input on abort)
  React.useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId, text } = (e as CustomEvent).detail ?? {}
      if (targetId === sessionId) {
        const nextText = coerceInputText(text)
        setInputValue(nextText)
        inputValueRef.current = nextText
      }
    }
    window.addEventListener('craft:restore-input', handler)
    return () => window.removeEventListener('craft:restore-input', handler)
  }, [sessionId])

  const handleInputChange = React.useCallback((value: string) => {
    const nextText = coerceInputText(value)
    setInputValue(nextText)
    inputValueRef.current = nextText
    onInputChange(sessionId, nextText)
  }, [sessionId, onInputChange])

  // Attachments draft state — hydrated async from persisted refs on session switch.
  // `[]` is the safe default while hydration is in flight; FreeFormInput seeds its
  // local state from this prop and swaps in the restored list when ready.
  const [attachmentsValue, setAttachmentsValue] = React.useState<import('../../shared/types').FileAttachment[]>([])

  React.useEffect(() => {
    let cancelled = false
    setAttachmentsValue([])
    hydrateDraftAttachments(sessionId).then((atts) => {
      if (!cancelled) setAttachmentsValue(atts)
    })
    return () => { cancelled = true }
  }, [sessionId, hydrateDraftAttachments])

  const handleAttachmentsChange = React.useCallback((attachments: import('../../shared/types').FileAttachment[]) => {
    setAttachmentsValue(attachments)
    onAttachmentsChange(sessionId, attachments)
  }, [sessionId, onAttachmentsChange])

  // POO-135: picked web element references — a per-session jotai draft (no
  // persistence: an unsent reference dies with the session, matching the
  // prototype). Reads feed the composer chips; writes come from chip removal.
  // The ambient jotai store (the <JotaiProvider> context store), NOT
  // getDefaultStore() — the sync hook writes drafts into the provider store
  // (POO-135 r3); a default-store write here would land in a different store
  // and never reach the chips above.
  const store = useStore()
  const elementRefsValue = useAtomValue(
    React.useMemo(() => elementDraftRefsAtomFamily(sessionId), [sessionId]),
  )
  const handleElementRefsChange = React.useCallback((refs: import('@polo-ai/core/types').WebElementReference[]) => {
    store.set(elementDraftRefsAtomFamily(sessionId), refs)
  }, [sessionId, store])

  // POO-196: the per-session draft of @ project-asset mentions (same shape
  // and lifecycle as the element references above — a jotai draft that dies
  // with the session unless it rides a send).
  const projectAssetRefsValue = useAtomValue(
    React.useMemo(() => projectAssetDraftRefsAtomFamily(sessionId), [sessionId]),
  )
  const handleProjectAssetRefsChange = React.useCallback((refs: ProjectAssetMentionDraft[]) => {
    store.set(projectAssetDraftRefsAtomFamily(sessionId), refs)
  }, [sessionId, store])

  // POO-196: the business tab strip (消息 / 文件 / Pin) exists only for a
  // session bound to the COMMITTED enterprise product space. Both ids are
  // read structurally: the productSpaceId fields are landing with the
  // shared-layer work, and structural reads keep this page compiling (and
  // correct at runtime) either way.
  const [projectTab, setProjectTab] = React.useState<ProjectContextTab>('messages')
  // POO-196 R3 (P8/D8 degradation trigger ②): a browser/canvas/file-preview
  // pane occupying the right column forces the DRAWER form. Read from the
  // SAME atoms/hooks AppShell renders the pane from — these stay set while a
  // drawer merely suspends the native views, so occupancy can never be
  // misread as "the tool was closed" (D8).
  const contextFilePreviewVisible = Boolean(filePreview && filePreviewVisible)
  const chatCanvasApp = useAtomValue(canvasPaneAppAtomFamily(sessionId))
  const chatCanvasPresentation = useAtomValue(canvasPanePopoutAtomFamily(sessionId))
  const chatSidebarCanvas = chatCanvasApp && !chatCanvasPresentation?.poppedOut && chatCanvasPresentation?.isVisible !== false
    ? chatCanvasApp
    : null
  const chatRemoteWorkspaceId = React.useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId)?.remoteServer?.remoteWorkspaceId ?? null,
    [workspaces, activeWorkspaceId],
  )
  const { browserSlotOpen: chatBrowserSlotOpen } = useRightPanePresentation({
    currentSessionId: sessionId,
    activeWorkspaceId: activeWorkspaceId ?? null,
    remoteWorkspaceId: chatRemoteWorkspaceId,
    fileVisible: contextFilePreviewVisible,
    canvasVisible: Boolean(chatSidebarCanvas),
  })
  const membersToolPaneOccupied = contextFilePreviewVisible || Boolean(chatSidebarCanvas) || chatBrowserSlotOpen
  const sessionProductSpaceId = (session as { productSpaceId?: string } | null)?.productSpaceId
    ?? (sessionMeta as { productSpaceId?: string } | null)?.productSpaceId
    ?? null
  const activeProductSpace = productSpace?.activeProductSpace
  const isProjectSession = !!sessionProductSpaceId
    && activeProductSpace?.kind === 'enterprise'
    && activeProductSpace.id === sessionProductSpaceId
  const projectScope = React.useMemo(() => (
    isProjectSession && activeWorkspaceId && sessionProductSpaceId
      ? { workspaceId: activeWorkspaceId, productSpaceId: sessionProductSpaceId }
      : null
  ), [isProjectSession, activeWorkspaceId, sessionProductSpaceId])
  const showProjectTabs = isProjectSession && projectScope !== null
  // POO-196 R3 (P8/D8): the members PANEL is project-level and shared by BOTH
  // ChatPage branches (with-messages and skeleton). The host hook owns the
  // open state, the push/drawer form factor (lane measurement + tool-pane
  // occupancy) and the drawer's native-pane suspension.
  const membersLaneRef = React.useRef<HTMLDivElement | null>(null)
  const membersTriggerRef = React.useRef<HTMLButtonElement | null>(null)
  // P9 entry roster: the ALL-ROLES collaboration projection (never the
  // management roster) feeds the header「成员 N」stack and the panel alike.
  const membersRoster = useCollaborationRoster(showProjectTabs && productSpace && projectScope
    ? { accountId: productSpace.accountId, productSpaceId: projectScope.productSpaceId }
    : null)
  // U7 entry authority + UB4 (U5) invite capability: the roster viewerRole is
  // the live authority; a roster 403 (real lost access) removes the glyph and
  // the onboarding auto-open whatever the space summary said.
  const membersEntryLostAccess = membersRoster.errorKey === 'projectMembers.error.forbidden'
  const membersEntryRole = membersEntryLostAccess
    ? null
    : (membersRoster.viewerRole ?? (activeProductSpace?.kind === 'enterprise' ? activeProductSpace.role : null))
  const membersCanInvite = membersEntryRole === 'owner' || membersEntryRole === 'manager'
  const membersPanelHost = useProjectMembersPanelHost({
    enabled: showProjectTabs,
    laneRef: membersLaneRef,
    toolPaneOccupied: membersToolPaneOccupied,
    triggerRef: membersTriggerRef,
    // UB4 (U5): this ChatPage IS the conversation host for a recovered
    // create whose landing has history (「已有历史的恢复落点也由 ChatPage
    // 接住」) — the one-time intent is consumed HERE when the entry is ready
    // on the committed target and this viewer may invite; the panel opens
    // straight on the 添加成员 selection page.
    onboardingScope: showProjectTabs && projectScope && productSpace
      ? { accountId: productSpace.accountId, productSpaceId: projectScope.productSpaceId }
      : null,
    canInvite: membersCanInvite,
    // 「关闭后聚焦输入框」— the composer is this page's input.
    onOnboardingClosed: () => dispatchFocusInputEvent({ sessionId }),
  })
  const handleOpenProjectMembers = membersPanelHost.openPanel
  // POO-196 R3 D13.1 + UB2 U11: the entry-in-flight fence. The PRIMARY gate
  // is the composer's synchronous admission callback (submitGate below — it
  // refuses INSIDE FreeFormInput before the draft clears/annotation markers),
  // while THIS deep pending check in the send handler stays as the backstop
  // for any path that might bypass the composer gate. A ref keeps the
  // callbacks reading the live value without being rebuilt on every atom tick.
  const entryState = useAtomValue(projectEntryAtom)
  const entryPending = useProjectEntryPending()
  const entryPendingRef = React.useRef(entryPending)
  entryPendingRef.current = entryPending
  // U11 notice markers: a USER-triggered blocked send records ONE contentless
  // marker (account/project/draft-key/generation) that drives the
  // post-landing「请点击发送」/「返回原对话」guidance. Consumed by actually
  // sending the draft; purged wholesale when the account changes (in the
  // shared entry owner).
  const setSendNotices = useSetAtom(projectEntrySendNoticesAtom)
  const sendNotices = useAtomValue(projectEntrySendNoticesAtom)
  const recordBlockedSendNotice = React.useCallback((draftKey: string, draftProject: string | null) => {
    const entry = entryState
    const account = productSpace?.accountId ?? null
    if (!account) return
    setSendNotices(notices => [
      ...notices.filter(notice => !(notice.accountId === account && notice.draftKey === draftKey)),
      {
        accountId: account,
        productSpaceId: draftProject ?? entry.productSpaceId ?? '',
        draftKey,
        generation: entry.generation,
      },
    ])
  }, [entryState, productSpace?.accountId, setSendNotices])
  const clearSendNotice = React.useCallback((draftKey: string) => {
    const account = productSpace?.accountId
    if (!account) return
    setSendNotices(notices => notices.filter(notice => !(notice.accountId === account && notice.draftKey === draftKey)))
  }, [productSpace?.accountId, setSendNotices])
  // The composer's admission gate: refuses ONLY while an entry is in flight —
  // the draft belongs to ITS conversation and a failure/scope-mismatch is the
  // deep check's business, not the gate's.
  const submitGate = React.useCallback(() => {
    if (!entryPendingRef.current) return true
    recordBlockedSendNotice(sessionId, sessionProductSpaceId)
    toast.error(t('project.entry.sendBlocked'))
    return false
  }, [recordBlockedSendNotice, sessionProductSpaceId, sessionId, t])
  // U11 persistent notice above the input: the waiting-time prompt while an
  // entry is in flight, then the landing guidance for a recorded blocked
  // draft —「请点击发送」in the original conversation,「返回原对话」elsewhere.
  const gateNotice = React.useMemo(() => {
    if (isEntryPendingState(entryState)) return t('project.entry.sendBlocked')
    const account = productSpace?.accountId ?? null
    if (!account) return null
    // The marker for THIS conversation wins (sendReady); any other retained
    // draft of the same account shows the「返回原对话」guidance.
    const mine = sendNotices.find(notice => notice.accountId === account && notice.draftKey === sessionId)
      ?? sendNotices.find(notice => notice.accountId === account)
    if (!mine) return null
    if (mine.draftKey === sessionId) {
      const retainedDraft = (inputValueRef.current.trim().length > 0)
        || attachmentsValue.length > 0
        || elementRefsValue.length > 0
        || projectAssetRefsValue.length > 0
      return retainedDraft ? t('project.entry.sendReady') : null
    }
    return t('project.entry.sendRetainedElsewhere')
    // F1 (glm review): depend on the draft VALUE (not the ref identity) so the
    // notice recomputes — and a cleared original draft consumes its marker.
    }, [attachmentsValue, elementRefsValue, entryState, inputValue, productSpace?.accountId, projectAssetRefsValue, sendNotices, sessionId, t])
  React.useEffect(() => {
    // A session switch resets to 消息 (default tab — the current behavior) and
    // closes the members panel with it (the panel instance survives the
    // switch, so a stale `open` state would resurrect it on the way back).
    setProjectTab('messages')
    membersPanelHost.closePanel()
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps -- closePanel identity is stable; the guard keeps the switch scoped to sessionId
  const projectPaneVisible = showProjectTabs && projectTab !== 'messages'
  // (The P9 entry roster feeds the host hook above — declared there once.)
  // D-C: the controlled external「前往企业管理」handoff — the same fail-closed
  // click-time check TopBar performs, re-derived from the LIVE scope at click
  // time; the desktop Bearer never rides the URL.
  const handleOpenEnterpriseManagement = React.useCallback(async () => {
    const scope = productSpace
    const space = scope?.activeProductSpace
    if (!scope || scope.pendingSwitch || !space || space.kind !== 'enterprise') return
    if (space.role !== 'owner' && space.role !== 'manager') return
    try {
      const status = await window.electronAPI.adminGetStatus()
      if (!status.loggedIn || !status.adminUrl || status.userId !== scope.accountId) {
        toast.error(t('topbar.account.enterpriseOpenFailed'), { description: t('homeApps.errors.staleContext') })
        return
      }
      await window.electronAPI.openUrl(
        createEnterpriseWorkflowUrl(status.adminUrl, space.enterpriseId, 'members'),
      )
    } catch {
      toast.error(t('topbar.account.enterpriseOpenFailed'))
    }
  }, [productSpace, t])
  // One panel element, rendered inside BOTH return branches so the skeleton
  // (messages-still-loading) session offers the same members entry. The push
  // form sits INSIDE the lane row (a flex sibling); the drawer portals itself.
  const projectMembersPanel = showProjectTabs && projectScope && productSpace && activeProductSpace?.kind === 'enterprise'
    ? (
      <ProjectMembersPanel
        open={membersPanelHost.open}
        mode={membersPanelHost.mode}
        scope={{ accountId: productSpace.accountId, productSpaceId: projectScope.productSpaceId }}
        projectName={activeProductSpace.name}
        viewerRole={activeProductSpace.role}
        assertedEnterpriseId={activeProductSpace.enterpriseId}
        roster={membersRoster}
        onClose={membersPanelHost.closePanel}
        onOpenEnterpriseManagement={() => { void handleOpenEnterpriseManagement() }}
        initialDirectory={membersPanelHost.directoryLanding}
        onboardingOpen={membersPanelHost.onboardingAutoOpen}
      />
    )
    : null
  // P9 header entry (U7 button): 「成员 N」 with up to three roster avatars,
  // a trailing add-member glyph for owner/manager, ≥32px tall with a border
  // + light fill. The roster-unknown fallback is the plain icon + label —
  // never a fabricated count. D11 keeps the pc-members-button testid and the
  // uniqueness: the tab strip no longer carries any members affordance.
  // (The roster/role computation lives with the host hook above.)
  const membersEntryButton = showProjectTabs ? (
    <button
      type="button"
      ref={membersTriggerRef}
      data-testid="pc-members-button"
      aria-label={t(membersCanInvite ? 'projectMembers.openMembersAndInvite' : 'projectMembers.buttonAria')}
      aria-haspopup="dialog"
      aria-expanded={membersPanelHost.open}
      onClick={handleOpenProjectMembers}
      className="inline-flex h-8 min-h-[32px] shrink-0 items-center gap-1.5 rounded-[6px] border border-border bg-foreground-5 px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
    >
      <ProjectMembersEntryLabel roster={membersRoster} showInviteAffordance={membersCanInvite} />
    </button>
  ) : null
  // X6: both project panes stay MOUNTED (hidden) across tab flips, so a
  // 消息 round-trip no longer discards scroll position, in-flight previews or
  // an open upload dialog. The key folds the workspace + product space in, so
  // an account or space switch remounts them and their state can never leak
  // across scopes. Pin mutations tick a counter the files tab watches to
  // re-sync its pinned rows (the dead `onChanged` contract, now wired).
  const [pinsVersion, setPinsVersion] = React.useState(0)
  const handlePinsChanged = React.useCallback(() => setPinsVersion((version) => version + 1), [])
  const projectPaneKey = `${activeWorkspaceId ?? ''}::${sessionProductSpaceId ?? ''}`

  // S-01: the message staged for "share to project". Non-null opens the
  // dialog; a successful share lands the files and flips to the Files tab.
  const [shareTarget, setShareTarget] = React.useState<ShareToProjectTarget | null>(null)

  // Journey #8: a failed local send leaves a session-scoped prompt (not a
  // message). The explicit action restores the preserved draft into the
  // composer and focuses it — re-sending stays a deliberate user act, so a
  // send whose server receipt is unknown is never blindly re-issued, and a
  // double click settles on the first tap (the prompt is consumed).
  const sendFailure = useAtomValue(
    React.useMemo(() => sendFailureAtomFamily(sessionId), [sessionId]),
  )

  const handleRestoreSendFailureDraft = React.useCallback(() => {
    const failure = store.get(sendFailureAtomFamily(sessionId))
    if (!failure) return
    store.set(sendFailureAtomFamily(sessionId), null)
    window.dispatchEvent(new CustomEvent('craft:restore-input', {
      detail: { sessionId, text: failure.draft },
    }))
    dispatchFocusInputEvent({ sessionId })
  }, [sessionId, store])

  // Journey #8 (review F4): the user may prefer to abandon the preserved
  // draft and type something new — the prompt must be dismissible, and the
  // composer must stay usable while only this non-blocking prompt is up.
  const handleDiscardSendFailureDraft = React.useCallback(() => {
    store.set(sendFailureAtomFamily(sessionId), null)
  }, [store])

  // Check if session's locked connection has been removed
  const connectionUnavailable = React.useMemo(() =>
    isSessionConnectionUnavailable(session?.llmConnection, llmConnections),
    [session?.llmConnection, llmConnections]
  )

  // Journey #1: the banner decision (billing semantics + role split) is a
  // pure function; this component only translates keys and wires actions.
  // U10: the space kind feeds the no-ai-service split (a personal space has
  // no "admin" to point at); playground (no provider) counts as non-personal.
  const bannerDecision = React.useMemo(
    () => decideChatAccessBanner(chatAccessStatus, {
      canOpenPayment,
      isPersonalSpace: productSpace?.activeProductSpace?.kind === 'personal',
    }),
    [chatAccessStatus, canOpenPayment, productSpace?.activeProductSpace?.kind],
  )

  const inputStatusBanner = React.useMemo(() => {
    // Journey #1 billing block wins: under a hard access block a draft
    // prompt would be noise — the banner owns the messaging and the input.
    if (bannerDecision) {
      return {
        variant: bannerDecision.variant,
        message: t(
          bannerDecision.messageKey,
          bannerDecision.quotaResetAt !== undefined
            ? { reset: formatQuotaResetTime(bannerDecision.quotaResetAt, i18n.resolvedLanguage) }
            : {},
        ),
        ...(bannerDecision.action === 'recharge'
          ? { actionLabel: t('chat.statusBanner.recharge'), onAction: openPayment }
          : {}),
        ...(bannerDecision.action === 'retry-ai-config-sync'
          ? { actionLabel: t('chat.statusBanner.retrySync'), onAction: onRetryAiConfigSync }
          : {}),
        // U2, superseded by POO-177: this second action IS the manual billing
        // refresh — one real Admin read per click. While the read is in
        // flight it renders disabled + aria-busy with the short checking
        // copy (QUOTA-02); it still never auto-sends.
        ...(bannerDecision.secondaryAction === 'recheck-billing' && onRecheckBilling
          ? {
              secondaryActionLabel: t('billingRecheck.action'),
              onSecondaryAction: onRecheckBilling,
              secondaryActionDisabled: billingRecheckPending,
              secondaryActionBusy: billingRecheckPending,
            }
          : {}),
      }
    }
    // Journey #8: the failed-send prompt (title + collapsed detail + restore).
    // Non-blocking (review F4): it must not disable the composer — the user
    // may abandon the draft and type anew — so it carries an explicit
    // discard action instead.
    if (sendFailure) {
      return {
        variant: 'destructive' as const,
        message: sendFailure.title,
        detail: sendFailure.detail,
        actionLabel: t('chat.sendFailed.restoreDraft'),
        onAction: handleRestoreSendFailureDraft,
        dismissLabel: t('chat.sendFailed.discardDraft'),
        onDismiss: handleDiscardSendFailureDraft,
      }
    }
    return null
  }, [bannerDecision, onRetryAiConfigSync, onRecheckBilling, billingRecheckPending, openPayment, t, sendFailure, handleRestoreSendFailureDraft, handleDiscardSendFailureDraft])

  // Only the hard billing block disables the composer (review F4); the
  // failed-send prompt is advisory.
  const isChatInputDisabled = !!bannerDecision

  // Effective model for this session (session-specific or global fallback)
  const effectiveModel = React.useMemo(() => {
    if (session?.model) return session.model

    // When connection is unavailable, don't resolve through a different connection
    if (connectionUnavailable) return session?.model ?? ''

    const connectionSlug = resolveEffectiveConnectionSlug(
      session?.llmConnection, workspaceDefaultLlmConnection, llmConnections
    )
    const connection = connectionSlug ? llmConnections.find(c => c.slug === connectionSlug) : null

    return connection?.defaultModel ?? ''
  }, [session?.id, session?.model, session?.llmConnection, workspaceDefaultLlmConnection, llmConnections, connectionUnavailable])

  // Working directory for this session
  const workingDirectory = session?.workingDirectory
  const activeWorkspace = React.useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) || null,
    [workspaces, activeWorkspaceId]
  )
  const handleWorkingDirectoryChange = React.useCallback(async (path: string) => {
    if (!session) return
    await window.electronAPI.sessionCommand(session.id, { type: 'updateWorkingDirectory', dir: path })
  }, [session])

  const handleOpenFile = React.useCallback(
    async (path: string) => {
      // Resolve bare relative paths against session working directory,
      // or workspace root as a fallback when workingDirectory is not set.
      const resolved = (() => {
        if (path.startsWith('/') || path.startsWith('~/')) return path

        const baseDir = workingDirectory || activeWorkspace?.rootPath
        if (!baseDir) return path

        const cleanedBase = baseDir.replace(/\/+$/, '')
        const cleanedPath = path.replace(/^\.\//, '')
        return `${cleanedBase}/${cleanedPath}`
      })()

      // Smart fallback for missing files in AI output:
      // if the exact path doesn't exist, search nearby for same basename
      // (e.g. markdown/linkify.test.ts -> markdown/__tests__/linkify.test.ts).
      if (resolved.startsWith('/')) {
        const lastSlash = resolved.lastIndexOf('/')
        if (lastSlash > 0 && lastSlash < resolved.length - 1) {
          const parentDir = resolved.slice(0, lastSlash)
          const fileName = resolved.slice(lastSlash + 1)
          try {
            const matches = await window.electronAPI.searchFiles(parentDir, fileName)
            const files = matches.filter((m) => m.type === 'file' && m.name === fileName)
            const exact = files.find((m) => m.path === resolved)
            if (exact) {
              onOpenFile(exact.path)
              return
            }

            if (files.length === 1) {
              onOpenFile(files[0].path)
              toast.info(t('chat.openedClosestMatch', { path: files[0].relativePath }))
              return
            }
          } catch {
            // Search fallback is best-effort; proceed with original resolved path.
          }
        }
      }

      onOpenFile(resolved)
    },
    [onOpenFile, workingDirectory, activeWorkspace?.rootPath]
  )

  const handleOpenUrl = React.useCallback(
    (url: string) => {
      onOpenUrl(url)
    },
    [onOpenUrl]
  )

  // POO-172: assistant-markdown citation sources get a dedicated channel —
  // parsable http/https opens in the built-in browserPane (scoped to THIS
  // session/workspace), file paths keep the file preview, dangerous schemes
  // are rejected without any external fallback. Business URLs (error-card
  // open_url, user messages, settings handoffs) keep using handleOpenUrl.
  // The scope is read live so a click that races a session switch never
  // steals another session's browser pane. `remoteWorkspaceId` is the same
  // authoritative alias the browser tab strip filters by — a remote agent's
  // instance carries the mirror id, not the local one.
  const citationScopeRef = React.useRef<CitationSourceScope>({ sessionId: null, workspaceId: null, remoteWorkspaceId: null })
  citationScopeRef.current = {
    sessionId: session?.id ?? null,
    workspaceId: session?.workspaceId ?? activeWorkspaceId ?? null,
    remoteWorkspaceId: activeWorkspace?.remoteServer?.remoteWorkspaceId ?? null,
  }
  const openSourceUrl = React.useMemo(
    () =>
      createCitationSourceOpener({
        getSessionScope: () => citationScopeRef.current,
        onOpenFile: handleOpenFile,
        onExternalUrl: onOpenUrl,
        onBlocked: (reason) => {
          toast.error(t('toast.citationSourceBlocked'), { description: reason })
        },
      }),
    [handleOpenFile, onOpenUrl, t]
  )

  // Perf: Mark when data is ready
  const dataReadyMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (messageLoadState.messagesReady && session && dataReadyMarkedRef.current !== sessionId) {
      dataReadyMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'data.ready')
    }
  }, [sessionId, messageLoadState.messagesReady, session])

  // Perf: Mark render complete after paint
  React.useEffect(() => {
    if (session) {
      const rafId = requestAnimationFrame(() => {
        rendererPerf.endSessionSwitch(sessionId)
      })
      return () => cancelAnimationFrame(rafId)
    }
  }, [sessionId, session])

  // Get display title for header - use getSessionTitle for consistent fallback logic with SessionList
  // Priority: name > first user message > preview > "New chat"
  const displayTitle = session ? getSessionTitle(session) : (sessionMeta ? getSessionTitle(sessionMeta) : t('chat.session'))
  const isFlagged = session?.isFlagged || sessionMeta?.isFlagged || false
  const isArchived = session?.isArchived || sessionMeta?.isArchived || false
  const sharedUrl = session?.sharedUrl || sessionMeta?.sharedUrl || null
  const currentSessionStatus = session?.sessionStatus || sessionMeta?.sessionStatus || 'todo'
  const hasMessages = !!(session?.messages?.length || sessionMeta?.lastFinalMessageId)
  const hasUnreadMessages = sessionMeta
    ? !!(sessionMeta.lastFinalMessageId && sessionMeta.lastFinalMessageId !== sessionMeta.lastReadMessageId)
    : false
  // Use isAsyncOperationOngoing for shimmer effect (sharing, updating share, revoking, title regeneration)
  const isAsyncOperationOngoing = session?.isAsyncOperationOngoing || sessionMeta?.isAsyncOperationOngoing || false

  // Rename dialog state
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)
  const [renameName, setRenameName] = React.useState('')

  // Session action handlers
  const handleRename = React.useCallback(() => {
    setRenameName(displayTitle)
    setRenameDialogOpen(true)
  }, [displayTitle])

  const handleRenameSubmit = React.useCallback(() => {
    if (renameName.trim() && renameName.trim() !== displayTitle) {
      onRenameSession(sessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
  }, [sessionId, renameName, displayTitle, onRenameSession])

  // S-01: staging a share snapshots {text, attachments, sessionTitle} at
  // share-click time instead of keeping the live message. ChatPage re-renders
  // on session streaming and metadata updates; a target rebuilt per render
  // would hand the dialog a fresh reference, re-run its init effect, and
  // silently wipe whatever the user had already typed there (name, tags,
  // source note). The stable snapshot keeps the dialog's edits intact.
  const handleShareToProject = React.useCallback((message: import('../../shared/types').Message) => {
    setShareTarget({
      text: message.content,
      attachments: message.attachments ?? [],
      sessionTitle: displayTitle,
    })
  }, [displayTitle])
  const handleSharedToProject = React.useCallback((shared: import('@polo-ai/shared/protocol').PcAssetDto[]) => {
    setShareTarget(null)
    setProjectTab('files')
    toast.success(t('projectContext.toast.shared', { count: shared.length }))
  }, [t])

  const handleFlag = React.useCallback(() => {
    onFlagSession(sessionId)
  }, [sessionId, onFlagSession])

  const handleUnflag = React.useCallback(() => {
    onUnflagSession(sessionId)
  }, [sessionId, onUnflagSession])

  const handleArchive = React.useCallback(() => {
    onArchiveSession(sessionId)
  }, [sessionId, onArchiveSession])

  const handleUnarchive = React.useCallback(() => {
    onUnarchiveSession(sessionId)
  }, [sessionId, onUnarchiveSession])

  const handleMarkUnread = React.useCallback(() => {
    onMarkSessionUnread(sessionId)
  }, [sessionId, onMarkSessionUnread])

  const handleSessionStatusChange = React.useCallback((state: string) => {
    onSessionStatusChange(sessionId, state)
  }, [sessionId, onSessionStatusChange])

  const handleLabelsChange = React.useCallback((newLabels: string[]) => {
    onSessionLabelsChange?.(sessionId, newLabels)
  }, [sessionId, onSessionLabelsChange])

  const handleDelete = React.useCallback(async () => {
    await onDeleteSession(sessionId)
  }, [sessionId, onDeleteSession])

  const handleOpenInNewWindow = React.useCallback(async () => {
    const route = routes.view.allSessions(sessionId)
    const separator = route.includes('?') ? '&' : '?'
    const url = `poloai://${route}${separator}window=focused`
    try {
      await window.electronAPI?.openUrl(url)
    } catch (error) {
      console.error('[ChatPage] openUrl failed:', error)
    }
  }, [sessionId])

  // Sharing publishes the session directly — no confirm ask (POO-166), same as
  // the session-menu path in `useSessionMenuActions`.
  // Share action handlers
  const handleShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'shareToViewer' }) as { success: boolean; url?: string; error?: string } | undefined
    if (result?.success && result.url) {
      await navigator.clipboard.writeText(result.url)
      toast.success(t('toast.linkCopied'), {
        description: result.url,
        action: { label: t('sendToWorkspace.open'), onClick: () => window.electronAPI.openUrl(result.url!) },
      })
    } else {
      toast.error(t('toast.failedToShare'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

  const handleOpenInBrowser = React.useCallback(() => {
    if (sharedUrl) window.electronAPI.openUrl(sharedUrl)
  }, [sharedUrl])

  const handleCopyLink = React.useCallback(async () => {
    if (sharedUrl) {
      await navigator.clipboard.writeText(sharedUrl)
      toast.success(t('toast.linkCopied'))
    }
  }, [sharedUrl])

  const handleUpdateShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'updateShare' }) as { success: boolean; error?: string } | undefined
    if (result?.success) {
      toast.success(t('chat.shareUpdated'))
    } else {
      toast.error(t('chat.failedToUpdateShare'), { description: result?.error })
    }
  }, [sessionId])

  const handleRevokeShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revokeShare' }) as { success: boolean; error?: string } | undefined
    if (result?.success) {
      toast.success(t('chat.sharingStopped'))
    } else {
      toast.error(t('chat.failedToStopSharing'), { description: result?.error })
    }
  }, [sessionId])

  // Share button with dropdown menu rendered in PanelHeader actions slot
  const shareButton = React.useMemo(() => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={sharedUrl ? t('chat.sharedSessionOptions') : t('chat.shareSession')}
          icon={sharedUrl
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.2383 10.2871C11.6481 10.0391 12.1486 10.0082 12.5811 10.1943L12.7617 10.2871L13.0088 10.4414C14.2231 11.227 15.1393 12.2124 15.8701 13.502C16.1424 13.9824 15.9736 14.5929 15.4932 14.8652C15.0127 15.1375 14.4022 14.9688 14.1299 14.4883C13.8006 13.9073 13.4303 13.417 13 12.9883V21C13 21.5523 12.5523 22 12 22C11.4477 22 11 21.5523 11 21V12.9883C10.5697 13.417 10.1994 13.9073 9.87012 14.4883C9.59781 14.9688 8.98732 15.1375 8.50684 14.8652C8.02643 14.5929 7.8576 13.9824 8.12988 13.502C8.90947 12.1264 9.90002 11.0972 11.2383 10.2871ZM11.5 3C14.2848 3 16.6594 4.75164 17.585 7.21289C20.1294 7.90815 22 10.235 22 13C22 16.3137 19.3137 19 16 19H15V16.9961C15.5021 16.9966 16.0115 16.8707 16.4795 16.6055C17.9209 15.7885 18.4272 13.9571 17.6104 12.5156C16.6661 10.8495 15.4355 9.56805 13.7969 8.57617C12.692 7.90745 11.308 7.90743 10.2031 8.57617C8.56453 9.56806 7.3339 10.8495 6.38965 12.5156C5.57277 13.957 6.07915 15.7885 7.52051 16.6055C7.98851 16.8707 8.49794 16.9966 9 16.9961V19H7C4.23858 19 2 16.7614 2 14C2 11.9489 3.23498 10.1861 5.00195 9.41504C5.04745 5.86435 7.93852 3 11.5 3Z" />
              </svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" />
              </svg>
          }
          className={sharedUrl ? 'text-accent' : undefined}
        />
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end" sideOffset={8}>
        {sharedUrl ? (
          <>
            <StyledDropdownMenuItem onClick={handleOpenInBrowser}>
              <Globe className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.openInBrowser')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleCopyLink}>
              <Copy className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.copyLink')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleUpdateShare}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.updateShare')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={handleRevokeShare} variant="destructive">
              <Link2Off className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.stopSharing')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl('https://app.polo.z-h-ai.com/docs/go-further/sharing')}>
              <Info className="h-3.5 w-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        ) : (
          <>
            <StyledDropdownMenuItem onClick={handleShare}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" />
              </svg>
              <span className="flex-1">{t('chat.shareOnline')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl('https://app.polo.z-h-ai.com/docs/go-further/sharing')}>
              <Info className="h-3.5 w-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  ), [sharedUrl, handleShare, handleOpenInBrowser, handleCopyLink, handleUpdateShare, handleRevokeShare])

  const compactInfoButton = React.useMemo(() => {
    if (!isCompactMode || !sessionMeta) return undefined

    return (
      <SessionInfoPopover
        sessionId={sessionId}
        sessionFolderPath={session?.sessionFolderPath}
        presentation="drawer"
        trigger={(
          <PanelHeaderCenterButton
            icon={<Info className="h-4 w-4" />}
            aria-label={t("chat.sessionInfo")}
          />
        )}
      />
    )
  }, [isCompactMode, sessionId, session?.sessionFolderPath, sessionMeta, t])

  // Members entry (project sessions only) rides BEFORE the share/info control
  // in the header actions slot — desktop and compact alike (P9: the entry is
  // the header's own; the drawer it opens stays reachable on narrow windows).
  // POO-202: focus mode (沉浸模式) moved here from the TopBar brand slot —
  // it leads the share/close cluster at the chat window's top-right. Same
  // registry action as ⌘. and the native menu; compact mode force-hides
  // sidebar/navigator anyway, so the control would be dead there.
  const actionRegistry = useOptionalActionRegistry()
  const isFocusMode = useAtomValue(workbenchFocusModeAtom) === true
  const focusModeButton = React.useMemo(() => {
    if (isCompactMode) return undefined
    return (
      <PanelHeaderCenterButton
        icon={<Focus className="h-4 w-4" />}
        tooltip={t('menu.toggleFocusMode')}
        aria-pressed={isFocusMode}
        data-testid="chat-focus-toggle"
        onClick={() => actionRegistry?.execute('view.toggleFocusMode')}
        className={isFocusMode ? 'text-accent opacity-100' : undefined}
      />
    )
  }, [isCompactMode, isFocusMode, actionRegistry, t])

  const headerActions = isCompactMode ? (
    <div className="flex items-center">
      {membersEntryButton}
      {compactInfoButton}
    </div>
  ) : (
    <div className="flex items-center">
      {focusModeButton}
      {membersEntryButton}
      {shareButton}
    </div>
  )

  // Build title menu content for chat sessions using shared SessionMenu.
  // Desktop uses Radix DropdownMenu via PanelHeader; compact mode uses a
  // vaul Drawer (CompactSessionMenu) so submenus aren't clipped by the
  // panel container query on narrow viewports.
  const titleMenu = React.useMemo(() => (sessionMeta && !isCompactMode) ? (
    <SessionMenu
      item={sessionMeta}
      sessionStatuses={sessionStatuses ?? []}
      labels={labels ?? []}
      onLabelsChange={handleLabelsChange}
      onRename={handleRename}
      onFlag={handleFlag}
      onUnflag={handleUnflag}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onMarkUnread={handleMarkUnread}
      onSessionStatusChange={handleSessionStatusChange}
      onOpenInNewWindow={handleOpenInNewWindow}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    isCompactMode,
    sessionStatuses,
    labels,
    handleLabelsChange,
    handleRename,
    handleFlag,
    handleUnflag,
    handleArchive,
    handleUnarchive,
    handleMarkUnread,
    handleSessionStatusChange,
    handleOpenInNewWindow,
    handleDelete,
  ])

  const compactTitleMenu = React.useMemo(() => (sessionMeta && isCompactMode) ? (
    <CompactSessionMenu
      title={displayTitle}
      isRegeneratingTitle={isAsyncOperationOngoing}
      item={sessionMeta}
      sessionStatuses={sessionStatuses ?? []}
      labels={labels ?? []}
      onLabelsChange={handleLabelsChange}
      onRename={handleRename}
      onFlag={handleFlag}
      onUnflag={handleUnflag}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onMarkUnread={handleMarkUnread}
      onSessionStatusChange={handleSessionStatusChange}
      onOpenInNewWindow={handleOpenInNewWindow}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    isCompactMode,
    displayTitle,
    isAsyncOperationOngoing,
    sessionStatuses,
    labels,
    handleLabelsChange,
    handleRename,
    handleFlag,
    handleUnflag,
    handleArchive,
    handleUnarchive,
    handleMarkUnread,
    handleSessionStatusChange,
    handleOpenInNewWindow,
    handleDelete,
  ])

  // Handle missing session - loading or deleted
  if (!session) {
    if (sessionMeta) {
      // Session exists in metadata but not loaded yet - show loading state
      const skeletonSession = {
        id: sessionMeta.id,
        workspaceId: sessionMeta.workspaceId,
        workspaceName: '',
        name: sessionMeta.name,
        preview: sessionMeta.preview,
        lastMessageAt: sessionMeta.lastMessageAt || 0,
        messages: [],
        isProcessing: sessionMeta.isProcessing || false,
        isFlagged: sessionMeta.isFlagged,
        workingDirectory: sessionMeta.workingDirectory,
        enabledSourceSlugs: sessionMeta.enabledSourceSlugs,
      }

      return (
        <>
          {/* The chat lane (D8 measurement node): its content-box width is
              identical before and after the panel inserts itself, so one
              ResizeObserver serves the pre-insert lane width in both host
              forms. Push rides inside as a flex sibling; drawer portals out. */}
          <div ref={membersLaneRef} className="h-full flex min-h-0 min-w-0">
            <div className="h-full flex min-h-0 min-w-0 flex-1 flex-col">
              <PanelHeader  title={displayTitle} titleMenu={titleMenu} compactTitleMenu={compactTitleMenu} leadingAction={leadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
              {showProjectTabs && (
                <ProjectContextTabs value={projectTab} onValueChange={setProjectTab} />
              )}
              <div className={projectPaneVisible ? 'hidden' : 'flex-1 flex flex-col min-h-0'}>
                <ChatDisplay
                  ref={chatDisplayRef}
                  session={skeletonSession}
                  onSendMessage={() => {}}
                  submitGate={submitGate}
                  gateNotice={gateNotice}
                  onOpenFile={handleOpenFile}
                  onOpenUrl={handleOpenUrl}
                  onOpenSourceUrl={openSourceUrl}
                  currentModel={effectiveModel}
                  pendingPermission={undefined}
                  onRespondToPermission={onRespondToPermission}
                  pendingCredential={undefined}
                  onRespondToCredential={onRespondToCredential}
                  pendingQuestion={undefined}
                  onRespondToQuestion={onRespondToQuestion}
                  permissionMode={sessionOpts.permissionMode}
                  onPermissionModeChange={setPermissionMode}
                  enabledModes={enabledModes}
                  inputValue={inputValue}
                  onInputChange={handleInputChange}
                  attachmentsValue={attachmentsValue}
                  onAttachmentsChange={handleAttachmentsChange}
                  elementReferencesValue={elementRefsValue}
                  onElementReferencesChange={handleElementRefsChange}
                  sources={enabledSources}
                  skills={skills}
                  sessionStatuses={sessionStatuses}
                  onSessionStatusChange={handleSessionStatusChange}
                  workspaceId={activeWorkspaceId || undefined}
                  onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
                  workingDirectory={sessionMeta.workingDirectory}
                  onWorkingDirectoryChange={handleWorkingDirectoryChange}
                  messagesLoading={messageLoadState.messagesLoading || (messagesRetrying && !messageLoadState.messagesReady)}
                  messagesLoadError={messageLoadState.error === MESSAGES_UNAVAILABLE_SENTINEL ? t('chat.messagesUnavailable') : messageLoadState.error}
                  messagesRetrying={messagesRetrying}
                  onRetryMessagesLoad={handleRetryMessagesLoad}
                  searchQuery={sessionListSearchQuery}
                  isSearchModeActive={isSearchModeActive}
                  onMatchInfoChange={onChatMatchInfoChange}
                  connectionUnavailable={connectionUnavailable}
                  disabled={isChatInputDisabled}
                  inputStatusBanner={inputStatusBanner}
                  compactMode={!!isCompactMode}
                  projectComposer={showProjectTabs}
                  projectShareEnabled={showProjectTabs}
                  onShareToProject={handleShareToProject}
                />
              </div>
              {showProjectTabs && projectScope && (
                <>
                  <div className={projectPaneVisible && projectTab === 'files' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
                    <ProjectFileLibrary
                      key={projectPaneKey}
                      scope={projectScope}
                      currentUserId={productSpace?.accountId ?? null}
                      active={projectPaneVisible && projectTab === 'files'}
                      pinMutations={pinsVersion}
                    />
                  </div>
                  <div className={projectPaneVisible && projectTab !== 'files' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
                    <ProjectPinPane
                      key={projectPaneKey}
                      scope={projectScope}
                      active={projectPaneVisible && projectTab !== 'files'}
                      onChanged={handlePinsChanged}
                    />
                  </div>
                </>
              )}
            </div>
            {projectMembersPanel}
          </div>
          <RenameDialog
            open={renameDialogOpen}
            onOpenChange={setRenameDialogOpen}
            title={t('chat.renameSession')}
            value={renameName}
            onValueChange={setRenameName}
            onSubmit={handleRenameSubmit}
            placeholder={t('chat.enterSessionName')}
          />
        </>
      )
    }

    // Session truly doesn't exist
    return (
      <div className="h-full flex flex-col">
        <PanelHeader  title={t('chat.session')} leadingAction={leadingAction} rightSidebarButton={rightSidebarButton} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertCircle className="h-10 w-10" />
          <p className="text-sm">{t('chat.sessionNoLongerExists')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* The chat lane (D8 measurement node) — see the skeleton branch. */}
      <div ref={membersLaneRef} className="h-full flex min-h-0 min-w-0">
        <div className="h-full flex min-h-0 min-w-0 flex-1 flex-col">
          <PanelHeader  title={displayTitle} titleMenu={titleMenu} compactTitleMenu={compactTitleMenu} leadingAction={leadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
          {showProjectTabs && (
            <ProjectContextTabs value={projectTab} onValueChange={setProjectTab} />
          )}
          <div className={projectPaneVisible ? 'hidden' : 'flex-1 flex flex-col min-h-0'}>
            <ChatDisplay
              ref={chatDisplayRef}
              session={session}
              onSendMessage={(message, attachments, skillSlugs, elementReferences, projectAssetRefs) => {
                // D13.1 entry fence (BACKSTOP): the composer's submitGate is
                // the primary U11 gate and already refused before the draft
                // cleared; this deep pending check keeps any path that might
                // bypass the composer from delivering a send into the
                // PREVIOUS scope. A refused send here keeps the draft.
                if (entryPendingRef.current) {
                  toast.error(t('project.entry.scopeChanged'))
                  return
                }
                if (session) {
                  // U11: an ACCEPTED send consumes this conversation's
                  // blocked-send notice marker — the guidance did its job.
                  clearSendNotice(session.id)
                  onSendMessage(session.id, message, attachments, skillSlugs, undefined, elementReferences, projectAssetRefs)
                }
              }}
              submitGate={submitGate}
              gateNotice={gateNotice}
              onOpenFile={handleOpenFile}
              onOpenUrl={handleOpenUrl}
              onOpenSourceUrl={openSourceUrl}
              currentModel={effectiveModel}
              pendingPermission={pendingPermission}
              onRespondToPermission={onRespondToPermission}
              pendingCredential={pendingCredential}
              onRespondToCredential={onRespondToCredential}
              pendingQuestion={pendingQuestion}
              onRespondToQuestion={onRespondToQuestion}
              permissionMode={sessionOpts.permissionMode}
              onPermissionModeChange={setPermissionMode}
              enabledModes={enabledModes}
              inputValue={inputValue}
              onInputChange={handleInputChange}
              attachmentsValue={attachmentsValue}
              onAttachmentsChange={handleAttachmentsChange}
              elementReferencesValue={elementRefsValue}
              onElementReferencesChange={handleElementRefsChange}
              projectAssetRefsValue={projectAssetRefsValue}
              onProjectAssetRefsChange={handleProjectAssetRefsChange}
              sources={enabledSources}
              skills={skills}
              labels={labels}
              onLabelsChange={(newLabels) => onSessionLabelsChange?.(sessionId, newLabels)}
              sessionStatuses={sessionStatuses}
              onSessionStatusChange={handleSessionStatusChange}
              workspaceId={activeWorkspaceId || undefined}
              onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={handleWorkingDirectoryChange}
              sessionFolderPath={session?.sessionFolderPath}
              messagesLoading={messageLoadState.messagesLoading || (messagesRetrying && !messageLoadState.messagesReady)}
              messagesLoadError={messageLoadState.error === MESSAGES_UNAVAILABLE_SENTINEL ? t('chat.messagesUnavailable') : messageLoadState.error}
              messagesRetrying={messagesRetrying}
              onRetryMessagesLoad={handleRetryMessagesLoad}
              searchQuery={sessionListSearchQuery}
              isSearchModeActive={isSearchModeActive}
              onMatchInfoChange={onChatMatchInfoChange}
              connectionUnavailable={connectionUnavailable}
              disabled={isChatInputDisabled}
              inputStatusBanner={inputStatusBanner}
              compactMode={!!isCompactMode}
              projectComposer={showProjectTabs}
              projectShareEnabled={showProjectTabs}
              onShareToProject={handleShareToProject}
            />
          </div>
          {showProjectTabs && projectScope && (
            <>
              <div className={projectPaneVisible && projectTab === 'files' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
                <ProjectFileLibrary
                  key={projectPaneKey}
                  scope={projectScope}
                  currentUserId={productSpace?.accountId ?? null}
                  active={projectPaneVisible && projectTab === 'files'}
                  pinMutations={pinsVersion}
                />
              </div>
              <div className={projectPaneVisible && projectTab !== 'files' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
                <ProjectPinPane
                  key={projectPaneKey}
                  scope={projectScope}
                  active={projectPaneVisible && projectTab !== 'files'}
                  onChanged={handlePinsChanged}
                />
              </div>
            </>
          )}
        </div>
        {projectMembersPanel}
      </div>
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t('chat.renameSession')}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t('chat.enterSessionName')}
      />
      {projectScope && (
        <ShareToProjectDialog
          open={shareTarget !== null}
          scope={projectScope}
          sessionId={sessionId}
          target={shareTarget}
          onClose={() => setShareTarget(null)}
          onShared={handleSharedToProject}
        />
      )}
    </>
  )
})

export default ChatPage
