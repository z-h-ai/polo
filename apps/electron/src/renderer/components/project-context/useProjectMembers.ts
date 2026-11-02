import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClientCreateInvitationResponse,
  ClientInvitationEntry,
  ClientMemberEntry,
  ClientMemberRole,
} from '@polo-ai/shared/admin/client-enterprise-contract'

/**
 * POO-196 追加轮 project-members state hook (adjudication D-C).
 *
 * Authority stays server-side: this hook only decides WHICH surface to
 * render. The roster/invitation reads run for owner/manager surfaces and a
 * plain member's panel never issues a management call at all — the admin
 * 403 that would answer it stays the authority (D-C: 不以客户端禁用按钮代替),
 * and when it does arrive for a manager who just lost the role, the panel
 * clears its data instead of falling back to the previous cache.
 *
 * Every scope change (account / space) resets everything; the invitation
 * link a result page holds lives ONLY in this memory and dies with the step,
 * the dialog close or the scope — never storage, telemetry or chat.
 */

export type MembersStep = 'overview' | 'compose' | 'result'

export type MembersListState<T> = {
  items: T[]
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  /** i18n key of the load failure, when the FIRST page failed. */
  errorKey: string | null
}

export type InvitationOutcome = {
  result: ClientCreateInvitationResponse['result']
  invitation: ClientInvitationEntry
  /** Short-lived: only `created`/`replayed` of the caller's own valid
   * invitation ever carries one. Cleared when the step or dialog closes. */
  invitationUrl: string | null
}

function emptyList<T>(): MembersListState<T> {
  return { items: [], nextCursor: null, loading: false, loadingMore: false, errorKey: null }
}

function newRequestKey(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `pm-invite-${uuid}`
}

function errorCodeOf(error: unknown): string | null {
  const record = (error ?? {}) as Record<string, unknown>
  return typeof record.code === 'string' ? record.code : null
}

/** Stable i18n key for a roster/invitation load failure. */
export function membersErrorKey(code: string | null): string {
  switch (code) {
    case 'forbidden':
      return 'projectMembers.error.forbidden'
    case 'pm_signin_required':
    case 'unauthorized':
    case 'token_revoked':
    case 'account_disabled':
      return 'projectMembers.error.signinRequired'
    case 'pm_scope_changed':
      return 'projectMembers.error.scopeChanged'
    case 'pm_unavailable_in_personal':
      return 'projectMembers.error.spaceRequired'
    case 'not_found':
      return 'projectMembers.error.notFound'
    case 'validation_error':
    case 'pm_service_unavailable':
    default:
      return 'projectMembers.error.generic'
  }
}

/** Compose-box validation: exactly one target, matching the wire bound. */
export function parseInviteTarget(raw: string): { phone?: string; email?: string; errorKey: string | null } {
  const value = raw.trim()
  if (!value) return { errorKey: 'projectMembers.invite.targetRequired' }
  if (value.includes('@')) {
    if (value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { errorKey: 'projectMembers.invite.targetInvalid' }
    }
    return { email: value, errorKey: null }
  }
  const digits = value.replace(/[\s()-]/g, '')
  if (!/^\+?\d{5,20}$/.test(digits)) return { errorKey: 'projectMembers.invite.targetInvalid' }
  return { phone: digits, errorKey: null }
}

/** i18n key for an invitation-creation failure. */
function inviteErrorKey(code: string | null): string {
  switch (code) {
    case 'target_already_member':
      return 'projectMembers.invite.alreadyMember'
    case 'email_delivery_unavailable':
      return 'projectMembers.invite.emailUnavailable'
    case 'forbidden':
      return 'projectMembers.invite.forbidden'
    case 'idempotency_conflict':
      return 'projectMembers.invite.keyConflict'
    case 'pm_signin_required':
    case 'unauthorized':
    case 'token_revoked':
    case 'account_disabled':
      return 'projectMembers.error.signinRequired'
    case 'pm_scope_changed':
      return 'projectMembers.error.scopeChanged'
    case 'not_found':
      return 'projectMembers.error.notFound'
    default:
      return 'projectMembers.invite.failed'
  }
}

export function useProjectMembers(scope: {
  accountId: string
  productSpaceId: string
  projectName: string
  viewerRole: ClientMemberRole
} | null) {
  const scopeKey = scope ? `${scope.accountId}:${scope.productSpaceId}` : null

  const [step, setStep] = useState<MembersStep>('overview')
  const [roster, setRoster] = useState<MembersListState<ClientMemberEntry>>(emptyList)
  const [invitations, setInvitations] = useState<MembersListState<ClientInvitationEntry>>(emptyList)
  const [manageErrorKey, setManageErrorKey] = useState<string | null>(null)
  const [viewerRole, setViewerRole] = useState<ClientMemberRole | null>(scope?.viewerRole ?? null)
  const [composeTarget, setComposeTarget] = useState('')
  const [composeErrorKey, setComposeErrorKey] = useState<string | null>(null)
  const [composeSubmitting, setComposeSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<InvitationOutcome | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const canManage = viewerRole === 'owner' || viewerRole === 'manager'
  // Per-list generations: the two first-screen loads run CONCURRENTLY, so a
  // shared counter would let the later one invalidate the earlier response
  // forever (the roster would never leave its loading state).
  const rosterGenerationRef = useRef(0)
  const invitationsGenerationRef = useRef(0)

  // Scope change (account or space) clears EVERYTHING — data, steps, the
  // held link, compose state. 失权即清数据.
  useEffect(() => {
    rosterGenerationRef.current += 1
    invitationsGenerationRef.current += 1
    setStep('overview')
    setRoster(emptyList())
    setInvitations(emptyList())
    setManageErrorKey(null)
    setViewerRole(scope?.viewerRole ?? null)
    setComposeTarget('')
    setComposeErrorKey(null)
    setComposeSubmitting(false)
    setOutcome(null)
    setCopied(false)
    setCopyFailed(false)
  }, [scopeKey, scope?.viewerRole])

  const applyForbidden = useCallback(() => {
    // 403 never falls back to the previous cache: the panel clears and shows
    // the member surface with the lost-access note (the member surface is the
    // only place that note can render once the role is gone). Bumping BOTH
    // generations also discards the sibling list's still-in-flight SUCCESS —
    // it must not re-raise the viewer role after the 403 landed.
    rosterGenerationRef.current += 1
    invitationsGenerationRef.current += 1
    setRoster(emptyList())
    setInvitations(emptyList())
    setViewerRole('member')
    setManageErrorKey('projectMembers.error.lostAccess')
    setStep('overview')
  }, [])

  const loadRoster = useCallback(async (options?: { cursor?: string }) => {
    if (!scope) return
    const generation = ++rosterGenerationRef.current
    const first = !options?.cursor
    setRoster(previous => first
      ? { ...emptyList(), loading: true }
      : { ...previous, loadingMore: true })
    try {
      const response = await window.electronAPI.pmListProjectMembers({
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
        ...(options?.cursor ? { cursor: options.cursor } : {}),
      })
      if (generation !== rosterGenerationRef.current) return
      setViewerRole(response.viewerRole)
      setManageErrorKey(null)
      setRoster(previous => first
        ? { items: response.members, nextCursor: response.nextCursor, loading: false, loadingMore: false, errorKey: null }
        : {
            ...previous,
            items: [...previous.items, ...response.members],
            nextCursor: response.nextCursor,
            loadingMore: false,
            errorKey: null,
          })
    } catch (error) {
      if (generation !== rosterGenerationRef.current) return
      const code = errorCodeOf(error)
      if (code === 'forbidden') {
        applyForbidden()
        return
      }
      setRoster(previous => ({
        ...previous,
        loading: false,
        loadingMore: false,
        errorKey: membersErrorKey(code),
      }))
    }
  }, [applyForbidden, scope])

  const loadInvitations = useCallback(async (options?: { cursor?: string }) => {
    if (!scope) return
    const generation = ++invitationsGenerationRef.current
    const first = !options?.cursor
    setInvitations(previous => first
      ? { ...emptyList(), loading: true }
      : { ...previous, loadingMore: true })
    try {
      const response = await window.electronAPI.pmListProjectInvitations({
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
        ...(options?.cursor ? { cursor: options.cursor } : {}),
      })
      if (generation !== invitationsGenerationRef.current) return
      setViewerRole(response.viewerRole)
      setManageErrorKey(null)
      setInvitations(previous => first
        ? { items: response.invitations, nextCursor: response.nextCursor, loading: false, loadingMore: false, errorKey: null }
        : {
            ...previous,
            items: [...previous.items, ...response.invitations],
            nextCursor: response.nextCursor,
            loadingMore: false,
            errorKey: null,
          })
    } catch (error) {
      if (generation !== invitationsGenerationRef.current) return
      const code = errorCodeOf(error)
      if (code === 'forbidden') {
        applyForbidden()
        return
      }
      setInvitations(previous => ({
        ...previous,
        loading: false,
        loadingMore: false,
        errorKey: membersErrorKey(code),
      }))
    }
  }, [applyForbidden, scope])

  /** First open: the member surface reads NOTHING; a manager surface reads
   * both pages. A stale race between the two is fine — each applies only to
   * its own list. */
  const openOverview = useCallback(() => {
    setStep('overview')
    if (!scope) return
    if (viewerRole === 'member') return
    void loadRoster()
    void loadInvitations()
  }, [loadInvitations, loadRoster, scope, viewerRole])

  const loadMoreRoster = useCallback(() => {
    if (!roster.nextCursor || roster.loadingMore) return
    void loadRoster({ cursor: roster.nextCursor })
  }, [loadRoster, roster.nextCursor, roster.loadingMore])

  const loadMoreInvitations = useCallback(() => {
    if (!invitations.nextCursor || invitations.loadingMore) return
    void loadInvitations({ cursor: invitations.nextCursor })
  }, [invitations.nextCursor, invitations.loadingMore, loadInvitations])

  const openCompose = useCallback(() => {
    setComposeTarget('')
    setComposeErrorKey(null)
    setOutcome(null)
    setCopied(false)
    setCopyFailed(false)
    setStep('compose')
  }, [])

  /** Editing the target clears the previous validation error. */
  const editComposeTarget = useCallback((value: string) => {
    setComposeTarget(value)
    setComposeErrorKey(null)
  }, [])

  const cancelCompose = useCallback(() => {
    setComposeTarget('')
    setComposeErrorKey(null)
    setStep('overview')
  }, [])

  const closeResult = useCallback(() => {
    // The link dies with the step — it is never retained.
    setOutcome(null)
    setCopied(false)
    setCopyFailed(false)
    setStep('overview')
  }, [])

  const submitInvitation = useCallback(async (): Promise<boolean> => {
    if (!scope || composeSubmitting) return false
    const parsed = parseInviteTarget(composeTarget)
    if (parsed.errorKey) {
      setComposeErrorKey(parsed.errorKey)
      return false
    }
    setComposeErrorKey(null)
    setComposeSubmitting(true)
    try {
      const response = await window.electronAPI.pmCreateProjectInvitation({
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
        command: {
          createRequestKey: newRequestKey(),
          ...(parsed.phone ? { targetPhone: parsed.phone } : {}),
          ...(parsed.email ? { targetEmail: parsed.email } : {}),
        },
      })
      if (response.result === 'created' || response.result === 'replayed') {
        setOutcome({
          result: response.result,
          invitation: response.invitation,
          invitationUrl: response.invitationUrl,
        })
        setStep('result')
        // The new invitation is only listed after it exists; refresh the
        // visible records so the roster step and the list agree.
        void loadInvitations()
        return true
      }
      // existing / state_changed / credential_unrecoverable stay in compose
      // with a specific status message and the management entry point.
      setOutcome({
        result: response.result,
        invitation: response.invitation,
        invitationUrl: null,
      })
      setStep('result')
      void loadInvitations()
      return true
    } catch (error) {
      setComposeErrorKey(inviteErrorKey(errorCodeOf(error)))
      return false
    } finally {
      setComposeSubmitting(false)
    }
  }, [composeSubmitting, composeTarget, loadInvitations, scope])

  const copyLink = useCallback(async (): Promise<boolean> => {
    if (!outcome?.invitationUrl) return false
    setCopied(false)
    setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(outcome.invitationUrl)
      setCopied(true)
      return true
    } catch {
      setCopyFailed(true)
      return false
    }
  }, [outcome])

  const statusKeyOf = useCallback((status: ClientInvitationEntry['status']): string => {
    return `projectMembers.invitations.status.${status}`
  }, [])

  const roleKeyOf = useCallback((role: ClientMemberRole): string => {
    return `projectMembers.role.${role}`
  }, [])

  return useMemo(() => ({
    step,
    roster,
    invitations,
    manageErrorKey,
    viewerRole,
    canManage,
    composeTarget,
    composeErrorKey,
    composeSubmitting,
    outcome,
    copied,
    copyFailed,
    editComposeTarget,
    openOverview,
    loadMoreRoster,
    loadMoreInvitations,
    openCompose,
    cancelCompose,
    closeResult,
    submitInvitation,
    copyLink,
    statusKeyOf,
    roleKeyOf,
  }), [
    canManage,
    closeResult,
    composeErrorKey,
    composeSubmitting,
    composeTarget,
    copied,
    copyFailed,
    copyLink,
    invitations,
    loadMoreInvitations,
    loadMoreRoster,
    manageErrorKey,
    openCompose,
    openOverview,
    outcome,
    roleKeyOf,
    roster,
    statusKeyOf,
    step,
    submitInvitation,
    viewerRole,
  ])
}
