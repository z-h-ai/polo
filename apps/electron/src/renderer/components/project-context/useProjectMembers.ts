import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClientCreateInvitationResponse,
  ClientInvitationEntry,
  ClientMemberEntry,
  ClientMemberRole,
} from '@polo-ai/shared/admin/client-enterprise-contract'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'

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
 * The invitation command holds its request key per normalized compose target
 * (S2-ENG-3): a definite failure abandons the key, an unresolved one keeps it
 * so the user's explicit retry replays the SAME request and the server hands
 * back the still-valid link. Copying only ever writes an absolute https link
 * under the trusted admin origin (E2-2).
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

/** S2-ENG-3: the codes after which a request identity is ABANDONED. Each of
 * them is a server-side classification that decided about THIS payload — the
 * invitation definitively was not (or can no longer be) created by replaying
 * it, so retrying must mint a fresh key. Everything else — transport loss,
 * unclassified envelopes, auth/scope failures — keeps the key: an explicit
 * retry then replays the SAME request and the server hands back the link
 * (replayed). `idempotency_conflict` is here because the key is provably
 * bound to a different payload; keeping it could never succeed. */
const DEFINITE_INVITE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  'target_already_member',
  'email_delivery_unavailable',
  'forbidden',
  'validation_error',
  'idempotency_conflict',
])

/** Compose-box validation: exactly one target, matching the wire bound.
 * X2-9: when the deployment cannot deliver invitation emails, an email target
 * is rejected up front with its own message instead of surfacing later as a
 * server `email_delivery_unavailable`. */
export function parseInviteTarget(raw: string, options?: { allowEmail?: boolean }): { phone?: string; email?: string; errorKey: string | null } {
  const value = raw.trim()
  if (!value) return { errorKey: 'projectMembers.invite.targetRequired' }
  if (value.includes('@')) {
    if (options?.allowEmail === false) return { errorKey: 'projectMembers.invite.emailUnavailable' }
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
    case 'invitation_origin_unavailable':
      return 'projectMembers.invite.originUnavailable'
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

/** E2-2: the clipboard only ever receives an ABSOLUTE https link under the
 * trusted admin origin's `/invite/` path. A root-relative value (an admin
 * deployed without its public origin — the real response shape observed in
 * review) is resolved against the admin URL the desktop itself is signed in
 * to; never against a request Host, renderer input or an `http:` origin.
 * Module-level so the R3 panel can apply the SAME discipline to the
 * per-colleague links (D5) — anything else takes the copy-failure face. */
export async function resolveInvitationUrlValue(value: string): Promise<string | null> {
  const trimmed = value.trim()
  if (!trimmed) return null
  let candidate = trimmed
  if (trimmed.startsWith('/')) {
    try {
      const status = await window.electronAPI.adminGetStatus()
      const adminUrl = status.adminUrl
      if (!adminUrl) return null
      candidate = new URL(trimmed, adminUrl).toString()
    } catch {
      return null
    }
  }
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:') return null
    if (!parsed.pathname.startsWith('/invite/') || parsed.search || parsed.hash) return null
    return parsed.toString()
  } catch {
    return null
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
  /** X2-9: this deployment's invitation email capability, read with the
   * roster. `true` until a response says otherwise — an older admin simply
   * leaves the combined input in place and the server's
   * `email_delivery_unavailable` stays the authority. */
  const [emailDeliveryAvailable, setEmailDeliveryAvailable] = useState(true)
  const [composeTarget, setComposeTarget] = useState('')
  const [composeErrorKey, setComposeErrorKey] = useState<string | null>(null)
  const [composeSubmitting, setComposeSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<InvitationOutcome | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  /** S2-ENG-3: the request key of THIS compose, held together with the
   * normalized target it was minted for. An unresolved failure keeps it so an
   * explicit retry replays the same request and the server hands the link
   * back; changing the target, cancelling or reopening compose resets it. */
  const [composeRequest, setComposeRequest] = useState<{ target: string; key: string } | null>(null)
  /** X2-4: a response from an abandoned compose (cancelled, reopened or a
   * scope switch) must never steer the visible step. */
  const composeGenerationRef = useRef(0)
  /** UB3 (U2): a clipboard write that resolves AFTER an account/project
   * switch or a live authority loss must never publish「已复制」into the NEW
   * scope — copyLink re-checks this generation before every setState. */
  const copyGenerationRef = useRef(0)

  const canManage = viewerRole === 'owner' || viewerRole === 'manager'
  // Per-list generations: the two first-screen loads run CONCURRENTLY, so a
  // shared counter would let the later one invalidate the earlier response
  // forever (the roster would never leave its loading state).
  const rosterGenerationRef = useRef(0)
  const invitationsGenerationRef = useRef(0)

  // Scope change (account or space) clears EVERYTHING — data, steps, the
  // held link, compose state and the held request key. 失权即清数据.
  useEffect(() => {
    rosterGenerationRef.current += 1
    invitationsGenerationRef.current += 1
    composeGenerationRef.current += 1
    copyGenerationRef.current += 1
    setStep('overview')
    setRoster(emptyList())
    setInvitations(emptyList())
    setManageErrorKey(null)
    setViewerRole(scope?.viewerRole ?? null)
    setEmailDeliveryAvailable(true)
    setComposeTarget('')
    setComposeErrorKey(null)
    setComposeSubmitting(false)
    setComposeRequest(null)
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
    copyGenerationRef.current += 1
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
      setEmailDeliveryAvailable(response.emailDeliveryAvailable !== false)
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
      // E2-5: pm codes ride the context-bridge message marker; a bare
      // `.code` read would classify every failure as generic.
      const code = readRpcErrorCode(error)
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
      const code = readRpcErrorCode(error)
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

  /** R3 panel: load ONLY the invitation records (the roster projection comes
   * from useCollaborationRoster — the management roster of the old dialog is
   * not read by the new panel). Permission semantics unchanged: a 403 lands
   * on applyForbidden and clears everything. */
  const refreshInvitations = useCallback(() => {
    if (!scope) return
    void loadInvitations()
  }, [loadInvitations, scope])

  const loadMoreRoster = useCallback(() => {
    if (!roster.nextCursor || roster.loadingMore) return
    void loadRoster({ cursor: roster.nextCursor })
  }, [loadRoster, roster.nextCursor, roster.loadingMore])

  const loadMoreInvitations = useCallback(() => {
    if (!invitations.nextCursor || invitations.loadingMore) return
    void loadInvitations({ cursor: invitations.nextCursor })
  }, [invitations.nextCursor, invitations.loadingMore, loadInvitations])

  /** X2-7: an in-place retry for a FAILED FIRST page. Only reachable while
   * the error is showing, so a retry never duplicates a successful load and
   * never bypasses the permission re-check (a 403 still lands on the member
   * surface through applyForbidden, not on cached rows). */
  const retryRoster = useCallback(() => {
    if (roster.errorKey) void loadRoster()
  }, [loadRoster, roster.errorKey])

  const retryInvitations = useCallback(() => {
    if (invitations.errorKey) void loadInvitations()
  }, [invitations.errorKey, loadInvitations])

  const openCompose = useCallback(() => {
    composeGenerationRef.current += 1
    setComposeTarget('')
    setComposeErrorKey(null)
    setComposeRequest(null)
    setOutcome(null)
    setCopied(false)
    setCopyFailed(false)
    setStep('compose')
  }, [])

  /** Editing the target clears the previous validation error and abandons the
   * held request key — it was minted for the previous normalized target. */
  const editComposeTarget = useCallback((value: string) => {
    setComposeTarget(value)
    setComposeErrorKey(null)
    setComposeRequest(null)
  }, [])

  const cancelCompose = useCallback(() => {
    composeGenerationRef.current += 1
    setComposeTarget('')
    setComposeErrorKey(null)
    setComposeRequest(null)
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
    const parsed = parseInviteTarget(composeTarget, { allowEmail: emailDeliveryAvailable })
    if (parsed.errorKey) {
      setComposeErrorKey(parsed.errorKey)
      return false
    }
    const target = parsed.phone ?? parsed.email ?? ''
    setComposeErrorKey(null)
    setComposeSubmitting(true)
    // S2-ENG-3: reuse the key minted for THIS normalized target — an
    // unresolved failure then replays instead of stacking a second live
    // invitation for the same person.
    const held = composeRequest && composeRequest.target === target ? composeRequest.key : null
    const createRequestKey = held ?? newRequestKey()
    const generation = composeGenerationRef.current
    try {
      const response = await window.electronAPI.pmCreateProjectInvitation({
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
        command: {
          createRequestKey,
          ...(parsed.phone ? { targetPhone: parsed.phone } : {}),
          ...(parsed.email ? { targetEmail: parsed.email } : {}),
        },
      })
      if (generation !== composeGenerationRef.current) return false
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
      if (generation !== composeGenerationRef.current) return false
      const code = readRpcErrorCode(error)
      // A definite classification abandons the key (retry mints a fresh
      // one); anything else — transport loss, unclassified envelopes, auth —
      // KEEPS the key this submit actually used, so the user's explicit
      // retry REPLAYS the same request instead of stacking a second live
      // invitation behind a fresh key.
      const usedKey = held ?? createRequestKey
      if (code === null || !DEFINITE_INVITE_ERROR_CODES.has(code)) {
        setComposeRequest({ target, key: usedKey })
      } else {
        setComposeRequest(null)
      }
      setComposeErrorKey(inviteErrorKey(code))
      return false
    } finally {
      setComposeSubmitting(false)
    }
  }, [composeRequest, composeSubmitting, composeTarget, emailDeliveryAvailable, loadInvitations, scope])

const copyLink = useCallback(async (): Promise<boolean> => {
  if (!outcome?.invitationUrl || !scope) return false
  const generation = copyGenerationRef.current
  setCopied(false)
  setCopyFailed(false)
  const resolved = await resolveInvitationUrlValue(outcome.invitationUrl)
  if (generation !== copyGenerationRef.current) return false
  if (!resolved) {
    setCopyFailed(true)
    return false
  }
  try {
    await navigator.clipboard.writeText(resolved)
    // UB3 (U2): 失权/换 scope 的迟到复制不发布 — 复核账号/项目后丢弃。
    if (generation !== copyGenerationRef.current) return false
    setCopied(true)
    return true
  } catch {
    if (generation !== copyGenerationRef.current) return false
    setCopyFailed(true)
    return false
  }
}, [outcome, scope])

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
    emailDeliveryAvailable,
    composeTarget,
    composeErrorKey,
    composeSubmitting,
    outcome,
    copied,
    copyFailed,
    editComposeTarget,
    openOverview,
    refreshInvitations,
    loadMoreRoster,
    loadMoreInvitations,
    retryRoster,
    retryInvitations,
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
    emailDeliveryAvailable,
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
    refreshInvitations,
    retryInvitations,
    retryRoster,
    roleKeyOf,
    roster,
    statusKeyOf,
    step,
    submitInvitation,
    viewerRole,
  ])
}
