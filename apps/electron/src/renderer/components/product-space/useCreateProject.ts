import { useCallback, useMemo, useRef, useState } from 'react'
import {
  clientCreateEnterpriseCommandSchema,
  clientEnterpriseCreatePresentation,
  clientEnterprisePaymentResponsibilityTermsVersion,
  type ClientEnterpriseErrorCode,
} from '@polo-ai/shared/admin/client-enterprise-contract'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'

/**
 * POO-196 R3 create-project state hook (consensus P5, adjudication D7).
 *
 * The interaction contracts this hook owns:
 * - D-B 1/2 (retained): the confirmation checkbox defaults UNCHECKED and only
 *   an explicit submit mints consent; the echoed terms version is the contract
 *   literal, never a locally invented string.
 * - D-B 5/6 (retained): the Idempotency-Key is generated at explicit submit
 *   time and kept per account while the request is in flight or unresolved; a
 *   lost/unknown response NEVER mints a new key — the stored key feeds the
 *   「查询创建结果」recovery query, and only the user's explicit action
 *   retries. Editing the form abandons the stored key.
 * - D-B 7 (retained): success separates「项目已创建」from「进入项目」— a
 *   failed entry never re-creates.
 * - P5/D7 (R3): the purpose is OPTIONAL end to end (empty string is legal;
 *   nothing is ever copied from the name or synthesised as a placeholder).
 *   The owner name has NO standing input: the current account's effective
 *   display name is used automatically; only a MISSING or over-limit display
 *   name surfaces the in-form「你的姓名」completion field (whitespace counts
 *   as missing, the 64-code-unit bound validates in place, and nothing is
 *   ever silently truncated).
 */

export type CreateProjectFormValues = {
  name: string
  ownerName: string
  purpose: string
  responsibilityConfirmed: boolean
}

export type CreateProjectFieldErrors = {
  name?: string
  ownerName?: string
  purpose?: string
  responsibility?: string
}

/** One submitted request, retained per account until it resolves or the user
 * abandons it by editing the form. In-memory by design: no localStorage, no
 * telemetry, and a renderer reload loses only the ability to query, never
 * correctness (the server keeps the aggregate). Holds the EFFECTIVE values
 * (account display name already resolved into ownerName) — the shape that
 * produced the wire fingerprint. */
type StoredRequest = {
  accountId: string
  idempotencyKey: string
  values: CreateProjectFormValues
}

const storedRequests = new Map<string, StoredRequest>()

export type CreateProjectSubmitError = {
  code: string | null
  /** Definite failure (form stays editable) vs unresolved (recovery). */
  kind: 'definite' | 'unresolved'
}

export type CreateProjectOutcome = {
  productSpaceId: string
  enterpriseName: string
}

export type CreateProjectPhase =
  | 'form'
  | 'submitting'
  | 'created'
  | 'recovery'

/** Local validation failures are definite; transport-level codes we cannot
 * classify (timeout, socket drop, unknown envelope) mean the server may or
 * may not have committed — recovery, never an automatic resend.
 *
 * `idempotency_recovery_failed` and `enterprise_unique_constraint_conflict`
 * stay OUT of this set (consensus S2-ENG-2): both mean the server could NOT
 * prove the aggregate was not committed, so the stored key survives and the
 * receipt query stays available. `legacy_projection_inconsistent` remains
 * definite deliberately: the projection repair path is a server-side fix for
 * an already-settled aggregate — the receipt query cannot change its outcome,
 * and keeping the form editable is the only exit that exists.
 *
 * `contract_version_unsupported` is definite too: an admin deployment that
 * answers 409 never wrote anything, so the form stays editable with the
 * update-prompt copy. (The generated contract's code list gains the literal
 * additively; until then the pm layer surfaces it the same way.) */
const DEFINITE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...([
    'unauthorized',
    'token_revoked',
    'account_disabled',
    'forbidden',
    'not_found',
    'validation_error',
    'phone_verification_required',
    'account_enterprise_exists',
    'account_changed',
    'idempotency_conflict',
    'legacy_projection_inconsistent',
  ] as readonly ClientEnterpriseErrorCode[]),
  'pm_signin_required',
  'pm_scope_changed',
  'pm_unavailable_in_personal',
  'validation_error',
  'contract_version_unsupported',
])

function newIdempotencyKey(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `pm-create-${uuid}`
}

/** S2-ENG-1: "unchanged" means every field — the trimmed text is what the
 * fingerprint covers, so trailing whitespace is not a payload change; the
 * acknowledgement itself IS (consent is part of the command). */
function areValuesEqual(a: CreateProjectFormValues, b: CreateProjectFormValues): boolean {
  return a.name.trim() === b.name.trim()
    && a.ownerName.trim() === b.ownerName.trim()
    && a.purpose.trim() === b.purpose.trim()
    && a.responsibilityConfirmed === b.responsibilityConfirmed
}

/**
 * D7: the account display name (already trimmed by the caller's source) is
 * the automatic owner name when it sits within the 1–64 UTF-16 code-unit
 * bound; otherwise the form's own completion value stands in. This is the
 * ONLY place the two sources merge, so the wire payload always mirrors what
 * the fingerprint covers.
 */
function resolveEffectiveValues(
  values: CreateProjectFormValues,
  accountOwnerName: string,
  ownerNameMax: number,
): CreateProjectFormValues {
  const resolved = accountOwnerName.trim()
  const accountOwnerUsable = resolved.length >= 1 && resolved.length <= ownerNameMax
  return accountOwnerUsable ? { ...values, ownerName: resolved } : values
}

/**
 * @param accountId the creating account.
 * @param accountOwnerName the current account's effective display name
 *   (`displayName.trim()` from the signed-in admin user). May be null/empty
 *   or over the bound — that is exactly the「你的姓名」completion case, the
 *   caller does not pre-filter.
 */
export function useCreateProject(accountId: string, accountOwnerName?: string | null) {
  const [phase, setPhase] = useState<CreateProjectPhase>('form')
  const [values, setValues] = useState<CreateProjectFormValues>(() => ({
    name: '',
    ownerName: '',
    purpose: '',
    // D-B 1: never pre-checked — not by nickname prefill, not by restore.
    responsibilityConfirmed: clientEnterpriseCreatePresentation.responsibility.confirmDefaultChecked,
  }))
  const [fieldErrors, setFieldErrors] = useState<CreateProjectFieldErrors>({})
  const [submitError, setSubmitError] = useState<CreateProjectSubmitError | null>(null)
  const [outcome, setOutcome] = useState<CreateProjectOutcome | null>(null)
  const [querying, setQuerying] = useState(false)
  const [queryNotFound, setQueryNotFound] = useState(false)
  /** D-B 2: the server rejected the echoed terms version — show the
   * version-mismatch hint and require a FRESH explicit confirmation instead
   * of silently replacing the terms. */
  const [versionMismatch, setVersionMismatch] = useState(false)
  /** D-B 6: the stored key survives a dialog close for this account. */
  const [hasStoredRequest, setHasStoredRequest] = useState(() => storedRequests.has(accountId))
  const submitGenerationRef = useRef(0)

  // The account can change under a mounted dialog (relogin). A stored request
  // from another account is never shown, never queried.
  const storedForAccount = useMemo(() => {
    const stored = storedRequests.get(accountId) ?? null
    return stored && stored.accountId === accountId ? stored : null
  }, [accountId, hasStoredRequest])

  const presentation = clientEnterpriseCreatePresentation

  /**
   * P5: whether the「你的姓名」completion field must appear — i.e. the
   * account display name is missing (blank counts as missing) or exceeds the
   * 64-code-unit bound. When false, NO owner input renders at all.
   */
  const ownerNeedsInput = useMemo(() => {
    const resolved = (accountOwnerName ?? '').trim()
    return resolved.length < 1 || resolved.length > presentation.fieldLimits.ownerNameMax
  }, [accountOwnerName, presentation.fieldLimits.ownerNameMax])

  const setField = useCallback(<K extends keyof CreateProjectFormValues>(key: K, value: CreateProjectFormValues[K]) => {
    setValues(previous => ({ ...previous, [key]: value }))
    setFieldErrors(previous => ({ ...previous, [key]: undefined }))
    // Editing any field abandons the stored request: the payload no longer
    // matches its fingerprint, so the same key would 409 instead of replay.
    if (storedRequests.delete(accountId)) setHasStoredRequest(false)
    setQueryNotFound(false)
  }, [accountId])

  const setResponsibilityConfirmed = useCallback((checked: boolean) => {
    if (checked) setVersionMismatch(false)
    setField('responsibilityConfirmed', checked)
  }, [setField])

  const validate = useCallback((effective: CreateProjectFormValues): CreateProjectFieldErrors => {
    const errors: CreateProjectFieldErrors = {}
    if (!effective.name.trim()) errors.name = 'createProject.error.nameRequired'
    else if (effective.name.trim().length > presentation.fieldLimits.nameMax) errors.name = 'createProject.error.nameTooLong'
    // The owner bound only applies when the completion field stands in for a
    // missing/over-limit account display name; a usable display name can
    // never violate it by construction (resolveEffectiveValues).
    if (ownerNeedsInput) {
      if (!effective.ownerName.trim()) errors.ownerName = 'createProject.error.ownerNameRequired'
      else if (effective.ownerName.trim().length > presentation.fieldLimits.ownerNameMax) errors.ownerName = 'createProject.error.ownerNameTooLong'
    }
    // P5/D7: optional — empty or whitespace is legal, only the upper bound
    // is enforced. No required error, no name-derived placeholder.
    if (effective.purpose.trim().length > presentation.fieldLimits.purposeMax) errors.purpose = 'createProject.error.purposeTooLong'
    if (!effective.responsibilityConfirmed) errors.responsibility = 'createProject.confirmRequired'
    return errors
  }, [ownerNeedsInput, presentation.fieldLimits])

  /** The command sent on submit. The literal terms version comes from the
   * generated contract — the client cannot mint a future agreement. The
   * purpose stays an honest empty string when the member wrote nothing. */
  const buildCommand = useCallback((effective: CreateProjectFormValues) => clientCreateEnterpriseCommandSchema.parse({
    name: effective.name.trim(),
    ownerName: effective.ownerName.trim(),
    purpose: effective.purpose.trim(),
    paymentResponsibilityAccepted: true as const,
    paymentResponsibilityTermsVersion: clientEnterprisePaymentResponsibilityTermsVersion,
  }), [])

  const submit = useCallback(async (): Promise<CreateProjectOutcome | null> => {
    const effective = resolveEffectiveValues(values, accountOwnerName ?? '', presentation.fieldLimits.ownerNameMax)
    const errors = validate(effective)
    setFieldErrors(errors)
    if (Object.values(errors).some(Boolean)) return null
    const command = buildCommand(effective)
    const generation = ++submitGenerationRef.current
    setPhase('submitting')
    setSubmitError(null)
    setQueryNotFound(false)
    // S2-ENG-1: an unchanged explicit re-submit of a stored request REUSES its
    // key — the server answers the same aggregate (replayed), it never builds
    // a second one. A changed payload (setField drops the stored request) or a
    // first submit mints the key here, at the only moment consent exists.
    const previousStored = storedRequests.get(accountId) ?? null
    const samePayload = previousStored !== null && areValuesEqual(previousStored.values, effective)
    const idempotencyKey = samePayload && previousStored
      ? previousStored.idempotencyKey
      : newIdempotencyKey()
    const stored: StoredRequest = { accountId, idempotencyKey, values: effective }
    storedRequests.set(accountId, stored)
    setHasStoredRequest(true)
    try {
      const response = await window.electronAPI.pmCreateEnterprise({
        accountId,
        idempotencyKey: stored.idempotencyKey,
        command,
      })
      if (generation !== submitGenerationRef.current) return null
      // created AND replayed are the same aggregate — replay is not an error.
      const next: CreateProjectOutcome = {
        productSpaceId: response.productSpaceId,
        enterpriseName: response.enterpriseName,
      }
      setOutcome(next)
      setPhase('created')
      storedRequests.delete(accountId)
      setHasStoredRequest(false)
      return next
    } catch (error) {
      if (generation !== submitGenerationRef.current) return null
      // E2-5: the pm channels carry their codes through the context bridge's
      // message marker — a bare `.code` read never sees them.
      const code = readRpcErrorCode(error)
      const definite = code !== null && DEFINITE_ERROR_CODES.has(code)
      if (code === 'validation_error') {
        // Field bounds are enforced locally, so a server-side validation
        // failure is most plausibly a responsibility-terms mismatch: drop the
        // acknowledgement and make the user confirm again (never silent).
        setVersionMismatch(true)
        setValues(previous => ({ ...previous, responsibilityConfirmed: false }))
        // The server classified this payload as rejected BEFORE any write, and
        // its terms cannot be satisfied by replaying it — the request identity
        // is abandoned so the re-confirmed submit mints a fresh key.
        storedRequests.delete(accountId)
        setHasStoredRequest(false)
      }
      setSubmitError({ code, kind: definite ? 'definite' : 'unresolved' })
      if (definite) {
        // Definite failures keep the form editable; the stored request is
        // abandoned — resubmitting mints a fresh key for the same payload.
        storedRequests.delete(accountId)
        setHasStoredRequest(false)
        setPhase('form')
      } else {
        // Unresolved (timeout / disconnected / unclassified, including the
        // S2-ENG-2 codes that cannot prove non-commit): keep the key, offer
        // the receipt query and the explicit same-key retry. Never a silent
        // resend and never a new key.
        setPhase('recovery')
      }
      return null
    }
  }, [accountOwnerName, accountId, buildCommand, presentation.fieldLimits.ownerNameMax, validate, values])

  /** D-B 6: query the ORIGINAL request's receipt with the stored key. */
  const queryReceipt = useCallback(async (): Promise<CreateProjectOutcome | null> => {
    const stored = storedRequests.get(accountId)
    if (!stored || querying) return null
    const generation = submitGenerationRef.current
    setQuerying(true)
    setQueryNotFound(false)
    try {
      const receipt = await window.electronAPI.pmQueryCreateReceipt({
        accountId,
        createRequestKey: stored.idempotencyKey,
      })
      if (generation !== submitGenerationRef.current) return null
      if (receipt.state === 'created') {
        const next: CreateProjectOutcome = {
          productSpaceId: receipt.productSpaceId,
          enterpriseName: stored.values.name.trim(),
        }
        setOutcome(next)
        setPhase('created')
        storedRequests.delete(accountId)
        setHasStoredRequest(false)
        return next
      }
      // `unknown` is not a failure: the user may explicitly re-submit.
      setQueryNotFound(true)
      setPhase('recovery')
      return null
    } catch {
      if (generation !== submitGenerationRef.current) return null
      // Query failure keeps the recovery state and the stored key.
      setPhase('recovery')
      return null
    } finally {
      setQuerying(false)
    }
  }, [accountId, querying])

  /** Back to the form from recovery (consensus E2-6): a REAL exit, and the
   * stored key stays put — submit() reuses a stored key for an unchanged
   * payload, so the explicit re-submit replays the original request instead
   * of building a second aggregate (D-B 6). */
  const backToForm = useCallback(() => {
    setPhase('form')
    setQueryNotFound(false)
  }, [])

  const dismissSubmitError = useCallback(() => setSubmitError(null), [])

  const reset = useCallback(() => {
    submitGenerationRef.current += 1
    setPhase(storedRequests.has(accountId) ? 'recovery' : 'form')
    setFieldErrors({})
    setSubmitError(null)
    setOutcome(null)
    setQuerying(false)
    setQueryNotFound(false)
    setVersionMismatch(false)
    // E2-3 (D-B 1): reopening NEVER carries the previous consent — the
    // acknowledgement returns to its unchecked default. The text draft and
    // the stored recovery snapshot are deliberately untouched: the draft is a
    // consensus-r2 minimum (keep, pending a product call), and the stored
    // request is what keeps an unknown outcome queryable. Clearing the
    // checkbox must never discard that key.
    setValues(previous => ({
      ...previous,
      responsibilityConfirmed: clientEnterpriseCreatePresentation.responsibility.confirmDefaultChecked,
    }))
  }, [accountId])

  return {
    presentation,
    phase,
    values,
    fieldErrors,
    submitError,
    outcome,
    querying,
    queryNotFound,
    hasStoredRequest: hasStoredRequest && storedForAccount !== null,
    versionMismatch,
    ownerNeedsInput,
    setField,
    setResponsibilityConfirmed,
    submit,
    queryReceipt,
    backToForm,
    dismissSubmitError,
    reset,
  }
}
