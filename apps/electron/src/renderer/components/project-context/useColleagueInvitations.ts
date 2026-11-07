import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClientColleagueInvitationReceipt,
  ClientCreateColleagueInvitationResponse,
  ClientInvitationEntry,
} from '@polo-ai/shared/admin/client-enterprise-contract'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'

/**
 * POO-196 R3 colleague-invitation compose state hook (adjudication D5).
 *
 * The multi-select is a CLIENT-side fan-out: every selected colleague is ONE
 * `pmCreateColleagueInvitation` command under its own `createRequestKey` —
 * there is no batch body on the wire, no batch transaction on the server.
 * Outcomes are kept PER OBJECT in submit order (never folded into one
 * aggregate result), and a partial failure retries ONLY the failed/unresolved
 * objects: settled objects are never re-sent.
 *
 * Request-key discipline mirrors S2-ENG-3: a DEFINITE server classification
 * (the invitation provably was not, or can no longer be, created by
 * replaying) abandons the key — the retry mints a fresh one. An UNRESOLVED
 * failure (transport loss, unclassified envelope, auth) KEEPS the key — the
 * explicit retry replays the SAME request, and the recovery query can look
 * the original key up (`unknown` is not a failure). Link-bearing outcomes
 * (`created`/`replayed`, and a recovery `found` whose credential re-derived)
 * settle the object; the link lives only in this memory and dies with the
 * scope — never storage, telemetry or chat.
 */

export type ColleagueComposeTarget = {
  userId: string
  displayName: string | null
}

export type ColleagueInvitationTargetState =
  | 'pending'
  | 'created'
  | 'replayed'
  | 'existing'
  | 'state_changed'
  | 'credential_unrecoverable'
  /** The recovery query answered `unknown` for the held key — retryable. */
  | 'unknown'
  /** The recovery query FOUND the invitation for the held key (real status
   * inside `invitation`; a re-derived link may ride along). */
  | 'found'
  | 'failed'

export type ColleagueInvitationTargetResult = {
  userId: string
  displayName: string | null
  state: ColleagueInvitationTargetState
  invitation: ClientInvitationEntry | null
  /** Short-lived: only link-bearing outcomes of the caller's own still-valid
   * invitation ever carry one. Cleared with the scope. */
  invitationUrl: string | null
  /** The raw pm/contract error code of a `failed` object (null otherwise). */
  errorCode: string | null
  /** i18n key for a `failed` object. */
  errorKey: string | null
  /** A DEFINITE failure abandons its key (a retry mints a fresh one); an
   * unresolved one keeps it (a retry replays the SAME request). */
  definiteFailure: boolean
}

export const COLLEAGUE_COMPOSE_MAX_TARGETS = 50
export const COLLEAGUE_COMPOSE_CONCURRENCY = 4

/** S2-ENG-3/D5: the codes after which a request identity is ABANDONED — each
 * is a server-side classification that decided about THIS object before (or
 * in a way that forecloses) any write, so replaying the same key could never
 * succeed. Auth/scope/transport losses and unclassified envelopes keep the
 * key: the explicit retry replays and the recovery query can still look the
 * original request up. */
const DEFINITE_COLLEAGUE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  'target_already_member',
  'colleague_target_unavailable',
  'colleague_source_unavailable',
  'forbidden',
  'not_found',
  'validation_error',
  'idempotency_conflict',
  'contract_version_unsupported',
  'pm_unavailable_in_personal',
])

/** i18n key for one colleague object's failure. */
export function colleagueInviteErrorKey(code: string | null): string {
  switch (code) {
    case 'colleague_target_unavailable':
      return 'projectMembers.directory.targetUnavailable'
    case 'colleague_source_unavailable':
      return 'projectMembers.directory.sourceUnavailable'
    case 'target_already_member':
      return 'projectMembers.invite.alreadyMember'
    case 'idempotency_conflict':
      return 'projectMembers.invite.keyConflict'
    case 'invitation_origin_unavailable':
      return 'projectMembers.invite.originUnavailable'
    case 'forbidden':
      return 'projectMembers.invite.forbidden'
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
    default:
      return 'projectMembers.invite.failed'
  }
}

/** The settled, link-bearing (or at least server-settled) outcomes that a
 * retry must NEVER re-send. */
function isSettled(state: ColleagueInvitationTargetState): boolean {
  return state === 'created'
    || state === 'replayed'
    || state === 'existing'
    || state === 'state_changed'
    || state === 'credential_unrecoverable'
    || state === 'found'
}

function newRequestKey(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `pm-colleague-${uuid}`
}

/** Bounded worker pool (D5: 并发上限 4). Preserves the target order of the
 * results array — the pool only bounds CONCURRENCY, never reorders. */
async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await worker(item)
    }
  })
  await Promise.all(runners)
}

export function useColleagueInvitations(scope: {
  accountId: string
  productSpaceId: string
  /** The directory source the selection was made from (D5 command field).
   * null means no source is known — compose is not available. */
  sourceEnterpriseId: string | null
} | null) {
  const scopeKey = scope ? `${scope.accountId}:${scope.productSpaceId}:${scope.sourceEnterpriseId ?? ''}` : null

  const [results, setResults] = useState<ColleagueInvitationTargetResult[]>([])
  const [composing, setComposing] = useState(false)
  const [composeErrorKey, setComposeErrorKey] = useState<string | null>(null)
  const [queryingUserId, setQueryingUserId] = useState<string | null>(null)
  /** Per-scope generation: a scope change invalidates every still-in-flight
   * create/query, so an outcome can never land on the wrong panel. */
  const generationRef = useRef(0)
  const composingRef = useRef(false)
  /** Held request keys per object: the identity an unresolved failure keeps
   * so the explicit retry replays and the recovery query can look it up.
   * A definite failure (or a settled outcome) deletes its entry. */
  const heldKeysRef = useRef(new Map<string, string>())
  const resultsRef = useRef<ColleagueInvitationTargetResult[]>([])

  const setResultsSynced = useCallback((next: ColleagueInvitationTargetResult[]) => {
    resultsRef.current = next
    setResults(next)
  }, [])

  const patchResult = useCallback((userId: string, patch: (previous: ColleagueInvitationTargetResult) => ColleagueInvitationTargetResult) => {
    setResultsSynced(resultsRef.current.map(result => result.userId === userId ? patch(result) : result))
  }, [setResultsSynced])

  // Scope change (account / project / source) clears EVERYTHING — per-object
  // outcomes, held keys and the held links. 失权即清数据.
  useEffect(() => {
    generationRef.current += 1
    composingRef.current = false
    heldKeysRef.current = new Map()
    setResultsSynced([])
    setComposing(false)
    setComposeErrorKey(null)
    setQueryingUserId(null)
  }, [scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps -- scope identity is the dependency

  const createForTarget = useCallback(async (target: ColleagueComposeTarget, requestKey: string, generation: number): Promise<void> => {
    if (!scope) return
    patchResult(target.userId, previous => ({
      ...previous,
      state: 'pending',
      errorCode: null,
      errorKey: null,
      definiteFailure: false,
    }))
    try {
      const response = await window.electronAPI.pmCreateColleagueInvitation({
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
        command: {
          // The command schema needs a source; scope.sourceEnterpriseId is
          // validated non-null before the pool starts.
          sourceEnterpriseId: scope.sourceEnterpriseId as string,
          targetUserId: target.userId,
          createRequestKey: requestKey,
        },
      })
      if (generation !== generationRef.current) return
      heldKeysRef.current.delete(target.userId)
      const linked = response.result === 'created' || response.result === 'replayed'
      patchResult(target.userId, () => ({
        userId: target.userId,
        displayName: target.displayName,
        state: response.result,
        invitation: response.invitation,
        invitationUrl: linked ? response.invitationUrl : null,
        errorCode: null,
        errorKey: null,
        definiteFailure: false,
      }))
    } catch (error) {
      if (generation !== generationRef.current) return
      // E2-5: pm codes ride the context-bridge message marker; a bare
      // `.code` read would classify every failure as generic.
      const code = readRpcErrorCode(error)
      const definite = code !== null && DEFINITE_COLLEAGUE_ERROR_CODES.has(code)
      if (definite) heldKeysRef.current.delete(target.userId)
      else heldKeysRef.current.set(target.userId, requestKey)
      patchResult(target.userId, previous => ({
        ...previous,
        state: 'failed',
        errorCode: code,
        errorKey: colleagueInviteErrorKey(code),
        definiteFailure: definite,
      }))
    }
  }, [patchResult, scope])

  /** Runs the per-object fan-out for `targets` with the given key resolver
   * (fresh on first compose, held-or-fresh on a retry). */
  const runCompose = useCallback(async (
    targets: readonly ColleagueComposeTarget[],
    generation: number,
    keyOf: (target: ColleagueComposeTarget) => string,
  ): Promise<boolean> => {
    composingRef.current = true
    setComposing(true)
    setComposeErrorKey(null)
    await runPool(targets, COLLEAGUE_COMPOSE_CONCURRENCY, async target => {
      await createForTarget(target, keyOf(target), generation)
    })
    if (generation !== generationRef.current) return false
    composingRef.current = false
    setComposing(false)
    return resultsRef.current.every(result => isSettled(result.state))
  }, [createForTarget])

  /** D5: confirm fans the selection out into per-object commands, at most
   * MAX targets, at most 4 in flight. Returns true only when EVERY object
   * reached a settled outcome; partial failures stay visible per object. */
  const confirmInvitations = useCallback(async (targets: readonly ColleagueComposeTarget[]): Promise<boolean> => {
    if (!scope || composingRef.current) return false
    if (!scope.sourceEnterpriseId) {
      setComposeErrorKey('projectMembers.directory.sourceUnavailable')
      return false
    }
    if (targets.length === 0) return false
    if (targets.length > COLLEAGUE_COMPOSE_MAX_TARGETS) {
      setComposeErrorKey('projectMembers.directory.selectionLimit')
      return false
    }
    const generation = ++generationRef.current
    // A fresh compose mints FRESH keys: held keys belong to the previous
    // compose run, and replaying one now would resolve a different object
    // selection onto an old identity.
    heldKeysRef.current = new Map()
    setResultsSynced(targets.map(target => ({
      userId: target.userId,
      displayName: target.displayName,
      state: 'pending' as const,
      invitation: null,
      invitationUrl: null,
      errorCode: null,
      errorKey: null,
      definiteFailure: false,
    })))
    return runCompose(targets, generation, target => {
      const key = newRequestKey()
      heldKeysRef.current.set(target.userId, key)
      return key
    })
  }, [runCompose, scope, setResultsSynced])

  /** D5: 部分失败只重试失败项 — only `failed` objects (definite failures get
   * FRESH keys, unresolved ones REPLAY the held key) and objects still
   * `pending`/`unknown` from an unresolved run. Settled objects are never
   * re-sent. */
  const retryFailed = useCallback(async (): Promise<boolean> => {
    if (!scope || composingRef.current) return false
    if (!scope.sourceEnterpriseId) {
      setComposeErrorKey('projectMembers.directory.sourceUnavailable')
      return false
    }
    const retryable = resultsRef.current.filter(result => !isSettled(result.state))
    if (retryable.length === 0) return false
    const generation = ++generationRef.current
    return runCompose(retryable, generation, target => {
      const held = heldKeysRef.current.get(target.userId)
      if (held) return held
      const key = newRequestKey()
      heldKeysRef.current.set(target.userId, key)
      return key
    })
  }, [runCompose, scope])

  /** D5 recovery: 查询邀请结果 — the caller's own held key. `unknown` keeps
   * the object retryable (and the key); a `found` receipt settles the object
   * with its real masked status and, only while the credential re-derives,
   * the link. */
  const queryTarget = useCallback(async (userId: string): Promise<ColleagueInvitationTargetResult | null> => {
    if (!scope || composingRef.current) return null
    const requestKey = heldKeysRef.current.get(userId)
    if (!requestKey) return null
    const generation = generationRef.current
    setQueryingUserId(userId)
    try {
      const receipt: ClientColleagueInvitationReceipt = await window.electronAPI.pmQueryColleagueInvitation({
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
        createRequestKey: requestKey,
      })
      if (generation !== generationRef.current) return null
      const previous = resultsRef.current.find(result => result.userId === userId) ?? null
      if (receipt.state === 'found') {
        // Settled: the invitation exists and belongs to this key. Only a
        // re-derived link may ride along — its presence is the server's.
        heldKeysRef.current.delete(userId)
        patchResult(userId, result => ({
          ...result,
          state: 'found',
          invitation: receipt.invitation,
          invitationUrl: receipt.invitationUrl ?? null,
          errorCode: null,
          errorKey: null,
        }))
        return resultsRef.current.find(result => result.userId === userId) ?? null
      }
      patchResult(userId, result => ({
        ...result,
        state: 'unknown',
        errorCode: null,
        errorKey: null,
      }))
      return previous
    } catch (error) {
      if (generation !== generationRef.current) return null
      // Query failure keeps the object's pending/failed state and its held
      // key — the explicit retry path still replays.
      const code = readRpcErrorCode(error)
      patchResult(userId, result => result.state === 'pending'
        ? { ...result, state: 'failed', errorCode: code, errorKey: colleagueInviteErrorKey(code), definiteFailure: false }
        : result)
      return resultsRef.current.find(result => result.userId === userId) ?? null
    } finally {
      if (generation === generationRef.current) setQueryingUserId(null)
    }
  }, [patchResult, scope])

  /** Leaves the compose surface: per-object results are cleared together
   * with any held links (they live only in this memory). */
  const clearResults = useCallback(() => {
    generationRef.current += 1
    heldKeysRef.current = new Map()
    setResultsSynced([])
    setComposeErrorKey(null)
  }, [setResultsSynced])

  const failedCount = useMemo(
    () => results.filter(result => result.state === 'failed').length,
    [results],
  )
  const pendingCount = useMemo(
    () => results.filter(result => result.state === 'pending' || result.state === 'unknown').length,
    [results],
  )

  return useMemo(() => ({
    scopeKey,
    results,
    composing,
    composeErrorKey,
    queryingUserId,
    failedCount,
    pendingCount,
    confirmInvitations,
    retryFailed,
    queryTarget,
    clearResults,
  }), [
    clearResults,
    composeErrorKey,
    composing,
    confirmInvitations,
    failedCount,
    pendingCount,
    queryTarget,
    queryingUserId,
    retryFailed,
    results,
    scopeKey,
  ])
}

/** Type-only re-export so panels can name the response union without
 * importing the contract module directly. */
export type ColleagueCreateResponse = ClientCreateColleagueInvitationResponse
