import { useCallback, useMemo, useRef, useState } from 'react'
import {
  clientCreateEnterpriseCommandSchema,
  clientEnterpriseCreatePresentation,
  clientEnterprisePaymentResponsibilityTermsVersion,
  type ClientEnterpriseErrorCode,
} from '@polo-ai/shared/admin/client-enterprise-contract'

/**
 * POO-196 追加轮 create-project state hook (adjudication D-B).
 *
 * The seven interaction contracts this hook owns:
 * - D-B 1/2: the confirmation checkbox defaults UNCHECKED and only an
 *   explicit submit mints consent; the echoed terms version is the contract
 *   literal, never a locally invented string.
 * - D-B 5: the Idempotency-Key is generated at explicit submit time and
 *   kept per account while the request is in flight or unresolved.
 * - D-B 6: a lost/unknown response NEVER mints a new key — the stored key
 *   feeds the「查询创建结果」recovery query, and only the user's explicit
 *   action retries. Editing the form abandons the stored key (a different
 *   payload under the same key would be a 409, not a retry).
 * - D-B 7: success separates「项目已创建」from「进入项目」— the controlled
 *   switch is the caller's job; a failed entry never re-creates.
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
 * correctness (the server keeps the aggregate). */
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
 * may not have committed — recovery, never an automatic resend. */
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
    'idempotency_recovery_failed',
    'legacy_projection_inconsistent',
    'enterprise_unique_constraint_conflict',
  ] as readonly ClientEnterpriseErrorCode[]),
  'pm_signin_required',
  'pm_scope_changed',
  'pm_unavailable_in_personal',
  'validation_error',
])

function newIdempotencyKey(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `pm-create-${uuid}`
}

function errorCodeOf(error: unknown): string | null {
  const record = (error ?? {}) as Record<string, unknown>
  return typeof record.code === 'string' ? record.code : null
}

export function useCreateProject(accountId: string) {
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

  const validate = useCallback((): CreateProjectFieldErrors => {
    const errors: CreateProjectFieldErrors = {}
    if (!values.name.trim()) errors.name = 'createProject.error.nameRequired'
    else if (values.name.trim().length > presentation.fieldLimits.nameMax) errors.name = 'createProject.error.generic'
    if (!values.ownerName.trim()) errors.ownerName = 'createProject.error.ownerNameRequired'
    else if (values.ownerName.trim().length > presentation.fieldLimits.ownerNameMax) errors.ownerName = 'createProject.error.generic'
    if (!values.purpose.trim()) errors.purpose = 'createProject.error.purposeRequired'
    else if (values.purpose.trim().length > presentation.fieldLimits.purposeMax) errors.purpose = 'createProject.error.generic'
    if (!values.responsibilityConfirmed) errors.responsibility = 'createProject.confirmRequired'
    return errors
  }, [presentation.fieldLimits, values])

  /** The command sent on submit. The literal terms version comes from the
   * generated contract — the client cannot mint a future agreement. */
  const buildCommand = useCallback(() => clientCreateEnterpriseCommandSchema.parse({
    name: values.name.trim(),
    ownerName: values.ownerName.trim(),
    purpose: values.purpose.trim(),
    paymentResponsibilityAccepted: true as const,
    paymentResponsibilityTermsVersion: clientEnterprisePaymentResponsibilityTermsVersion,
  }), [values])

  const submit = useCallback(async (): Promise<CreateProjectOutcome | null> => {
    const errors = validate()
    setFieldErrors(errors)
    if (Object.values(errors).some(Boolean)) return null
    const command = buildCommand()
    const generation = ++submitGenerationRef.current
    setPhase('submitting')
    setSubmitError(null)
    setQueryNotFound(false)
    // D-B 5: minted at explicit submit time, then retained per account.
    const stored: StoredRequest = { accountId, idempotencyKey: newIdempotencyKey(), values }
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
      const code = errorCodeOf(error)
      const definite = code !== null && DEFINITE_ERROR_CODES.has(code)
      if (code === 'validation_error') {
        // Field bounds are enforced locally, so a server-side validation
        // failure is most plausibly a responsibility-terms mismatch: drop the
        // acknowledgement and make the user confirm again (never silent).
        setVersionMismatch(true)
        setValues(previous => ({ ...previous, responsibilityConfirmed: false }))
      }
      setSubmitError({ code, kind: definite ? 'definite' : 'unresolved' })
      if (definite) {
        // Definite failures keep the form editable; the stored request is
        // abandoned — resubmitting mints a fresh key for the same payload.
        storedRequests.delete(accountId)
        setHasStoredRequest(false)
        setPhase('form')
      } else {
        // Unresolved (timeout / disconnected / unclassified): keep the key,
        // offer the receipt query. Never a silent resend.
        setPhase('recovery')
      }
      return null
    }
  }, [accountId, buildCommand, validate])

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

  /** Back to the form from recovery. The stored key stays valid ONLY while
   * the payload is unchanged — submit() re-mints a key only when none is
   * stored, so an unchanged re-submit replays the original request. */
  const backToForm = useCallback(() => {
    setPhase(storedRequests.has(accountId) ? 'recovery' : 'form')
    setQueryNotFound(false)
  }, [accountId])

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
    setField,
    setResponsibilityConfirmed,
    submit,
    queryReceipt,
    backToForm,
    dismissSubmitError,
    reset,
  }
}
