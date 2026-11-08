import { useCallback, useMemo, useRef, useState } from 'react'
import {
  PROJECT_NAME_MAX_CHARS,
  PROJECT_PURPOSE_MAX_CHARS,
} from '@polo-ai/shared/protocol'
import type { PmOrganizationScopeInput, ProjectMutationResponse } from '@polo-ai/shared/protocol'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { createProjectInput, projectActionErrorKey } from '../projects/projects-api'

/**
 * POO-205 — the lightweight create-project state hook (Spec Q3).
 *
 * Creating a project is a lightweight operation INSIDE the committed
 * organization (`pm:createProject`, no payer / no payment terms / no phone
 * verification — the whole POO-196 client-side-enterprise surface is
 * retired). The form is name (required) + optional purpose only; the owner
 * is the acting account by construction and polo-admin decides authority,
 * so the renderer takes none of it as input.
 *
 * Failure semantics without a receipt channel: every failure is DEFINITE —
 * the form stays editable, the error classifies from the wire/local `pm_*`
 * code, and an explicit retry sends a fresh request (the server owns
 * idempotency; the renderer no longer mints keys or queries receipts).
 * Nothing is persisted; an unmount simply drops the in-flight generation.
 */

export type CreateProjectFormValues = {
  name: string
  purpose: string
}

export type CreateProjectFieldErrors = {
  name?: string
  purpose?: string
}

export type CreateProjectOutcome = ProjectMutationResponse['project']

export type CreateProjectPhase = 'form' | 'submitting'

export function useCreateProject(scope: PmOrganizationScopeInput | null) {
  const [phase, setPhase] = useState<CreateProjectPhase>('form')
  const [values, setValues] = useState<CreateProjectFormValues>({ name: '', purpose: '' })
  const [fieldErrors, setFieldErrors] = useState<CreateProjectFieldErrors>({})
  const [submitErrorKey, setSubmitErrorKey] = useState<string | null>(null)
  const submitGenerationRef = useRef(0)

  const fieldLimits = useMemo(() => ({
    nameMax: PROJECT_NAME_MAX_CHARS,
    purposeMax: PROJECT_PURPOSE_MAX_CHARS,
  }), [])

  const setField = useCallback(<K extends keyof CreateProjectFormValues>(key: K, value: CreateProjectFormValues[K]) => {
    setValues(previous => ({ ...previous, [key]: value }))
    setFieldErrors(previous => ({ ...previous, [key]: undefined }))
    setSubmitErrorKey(null)
  }, [])

  const validate = useCallback((effective: CreateProjectFormValues): CreateProjectFieldErrors => {
    const errors: CreateProjectFieldErrors = {}
    if (!effective.name.trim()) errors.name = 'createProject.error.nameRequired'
    else if (effective.name.trim().length > fieldLimits.nameMax) errors.name = 'createProject.error.nameTooLong'
    // P5 stays: the purpose is OPTIONAL end to end (empty is legal; only the
    // upper bound is enforced and nothing is ever derived from the name).
    if (effective.purpose.trim().length > fieldLimits.purposeMax) errors.purpose = 'createProject.error.purposeTooLong'
    return errors
  }, [fieldLimits])

  const submit = useCallback(async (): Promise<CreateProjectOutcome | null> => {
    if (!scope || phase === 'submitting') return null
    const effective = { name: values.name.trim(), purpose: values.purpose.trim() }
    const errors = validate(effective)
    setFieldErrors(errors)
    if (Object.values(errors).some(Boolean)) return null
    const generation = ++submitGenerationRef.current
    setPhase('submitting')
    setSubmitErrorKey(null)
    try {
      const response = await window.electronAPI.pmCreateProject(
        createProjectInput(scope, { name: effective.name, purpose: effective.purpose || undefined }),
      )
      if (generation !== submitGenerationRef.current) return null
      return response.project
    } catch (error) {
      if (generation !== submitGenerationRef.current) return null
      // E2-5: pm codes ride the context-bridge message marker; a bare
      // `.code` read would classify every failure as generic.
      setSubmitErrorKey(projectActionErrorKey(readRpcErrorCode(error)))
      setPhase('form')
      return null
    }
  }, [phase, scope, validate, values])

  const reset = useCallback(() => {
    submitGenerationRef.current += 1
    setPhase('form')
    setFieldErrors({})
    setSubmitErrorKey(null)
    setValues({ name: '', purpose: '' })
  }, [])

  const dismissSubmitError = useCallback(() => setSubmitErrorKey(null), [])

  return {
    fieldLimits,
    phase,
    values,
    fieldErrors,
    submitErrorKey,
    setField,
    submit,
    reset,
    dismissSubmitError,
  }
}
