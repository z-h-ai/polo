import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@polo-ai/ui/ui/checkbox'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchDialogClassName,
  clientWorkbenchOverlayClassName,
  clientWorkbenchPrimaryClassName,
  useClientWorkbenchStyle,
} from '@/components/ui/client-workbench'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { useCreateProject } from './useCreateProject'

/**
 * POO-196 追加轮 create-project dialog (adjudication D-B / D-D 1).
 *
 * One shared instance hosted by App next to the product-space switch dialog —
 * BOTH entries (account/space menu and the select screen) open the same
 * component, and the component stays mounted so a lost-response recovery and
 * an in-flight submit survive closing the dialog (D-B 6: closing the view
 * never implies the server write was cancelled — the stored key keeps the
 * receipt queryable).
 *
 * HIG: single primary action; Enter submits only when the form validates AND
 * the responsibility checkbox is explicitly checked; Escape closes an
 * uncommitted step; errors sit next to their field; the "created" state is
 * separate from the "entered" state and never re-creates.
 */

function submitErrorKey(code: string | null): string {
  switch (code) {
    case 'phone_verification_required':
      return 'createProject.error.phoneVerification'
    case 'account_enterprise_exists':
      return 'createProject.error.enterpriseExists'
    case 'idempotency_conflict':
      return 'createProject.error.conflict'
    case 'unauthorized':
    case 'token_revoked':
    case 'account_disabled':
    case 'pm_signin_required':
      return 'createProject.error.signinRequired'
    case 'forbidden':
      return 'createProject.error.forbidden'
    default:
      return 'createProject.error.generic'
  }
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onVerifyPhone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** D-B 3: desktop phone verification lives in the existing sign-in
   * challenge flow — this hands off to it, then the user re-reads their
   * identity and submits again. */
  onVerifyPhone: () => void
}) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const space = useProductSpaceContext()
  const accountId = space.accountId
  const creator = useCreateProject(accountId)
  const {
    presentation,
    phase,
    values,
    fieldErrors,
    submitError,
    outcome,
    querying,
    queryNotFound,
    hasStoredRequest,
    versionMismatch,
  } = creator

  const [enterFailed, setEnterFailed] = useState(false)
  const [entering, setEntering] = useState(false)
  // One automatic enter attempt per created outcome (D-B 7: refresh → find →
  // controlled switch; failure shows「项目已创建」+ recovery, no re-create).
  const attemptedOutcomeRef = useRef<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const enterCreatedProject = useCallback(async (productSpaceId: string) => {
    setEntering(true)
    try {
      const list = await space.onRefreshProductSpaces()
      const target = list?.find(item => item.id === productSpaceId)
        ?? space.productSpaces.find(item => item.id === productSpaceId)
      if (!target) {
        setEnterFailed(true)
        return
      }
      // The auto-enter dismisses the dialog with the SAME semantics as a
      // user close: reset the form (the created page must not resurface on
      // the next open — reopening offers a FRESH form, or the D-B 6 recovery
      // query when a stored key remains).
      creator.reset()
      onOpenChange(false)
      if (productSpaceId !== space.activeProductSpaceId) {
        space.onSelectProductSpace(productSpaceId)
      }
    } catch {
      setEnterFailed(true)
    } finally {
      setEntering(false)
    }
  }, [creator.reset, onOpenChange, space])

  // Auto-enter exactly once per outcome; afterwards only the visible action
  // retries (never a re-create).
  useEffect(() => {
    if (!open || !outcome || phase !== 'created') return
    const key = `${accountId}:${outcome.productSpaceId}`
    if (attemptedOutcomeRef.current === key) return
    attemptedOutcomeRef.current = key
    setEnterFailed(false)
    void enterCreatedProject(outcome.productSpaceId)
  }, [accountId, enterCreatedProject, open, outcome, phase])

  const runSubmit = useCallback(() => {
    if (phase !== 'form' || entering) return
    void creator.submit().then(result => {
      if (result) setEnterFailed(false)
    })
  }, [creator, entering, phase])

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      // Escape / close always closes an uncommitted step. An in-flight submit
      // keeps its stored key: reopening offers「查询创建结果」(D-B 6) — the
      // view closing never implies the server write was cancelled.
      creator.reset()
    }
    onOpenChange(next)
  }, [creator, onOpenChange])

  const existingEnterpriseSpace = space.productSpaces.find(item => item.kind === 'enterprise') ?? null
  const showEnterpriseExists = submitError?.code === 'account_enterprise_exists'
  const showPhoneVerification = submitError?.code === 'phone_verification_required'
  const submitMessageKey = submitError ? submitErrorKey(submitError.code) : null
  const formVisible = phase === 'form' || phase === 'submitting'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="create-project-dialog"
        data-phase={phase}
        style={workbenchStyle}
        overlayStyle={workbenchStyle}
        overlayClassName={clientWorkbenchOverlayClassName}
        className={clientWorkbenchDialogClassName}
        onOpenAutoFocus={event => {
          // Focus moves into the form, not back to a trigger inside a menu
          // that has already closed.
          event.preventDefault()
          nameInputRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle data-testid="create-project-title">
            {phase === 'created' ? t('createProject.created.title') : t('createProject.title')}
          </DialogTitle>
          <DialogDescription>
            {phase === 'created'
              ? t('createProject.created.description', { name: outcome?.enterpriseName ?? '' })
              : t('createProject.description')}
          </DialogDescription>
        </DialogHeader>

        {phase === 'created' ? (
          <div className="px-[20px] pb-[6px]">
            {enterFailed ? (
              <div
                role="status"
                data-testid="create-project-enter-failed"
                className="flex items-start gap-[8px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
              >
                <AlertCircle className="mt-[2px] size-[14px] shrink-0" aria-hidden="true" />
                <span>{t('createProject.created.refreshFailed')}</span>
              </div>
            ) : entering ? (
              <p className="flex items-center gap-[8px] text-[12px] text-muted-foreground" data-testid="create-project-entering">
                <Loader2 className="size-[14px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <span>{t('createProject.created.description', { name: outcome?.enterpriseName ?? '' })}</span>
              </p>
            ) : null}
          </div>
        ) : phase === 'recovery' ? (
          <div className="px-[20px] pb-[6px]" data-testid="create-project-recovery">
            <div className="rounded-[10px] border border-border bg-foreground-5 px-[12px] py-[10px] text-[12px] leading-[1.55]">
              <strong className="block text-foreground">{t('createProject.recovery.title')}</strong>
              <span className="text-muted-foreground">
                {queryNotFound ? t('createProject.recovery.notFound') : t('createProject.recovery.description')}
              </span>
            </div>
          </div>
        ) : null}

        {formVisible ? (
          <form
            id="create-project-form"
            className="px-[20px] pb-[6px]"
            onSubmit={event => {
              event.preventDefault()
              runSubmit()
            }}
            noValidate
          >
            {hasStoredRequest ? (
              <div
                role="status"
                data-testid="create-project-stored-request"
                className="mb-[12px] flex items-center justify-between gap-[10px] rounded-[10px] border border-border bg-foreground-5 px-[12px] py-[8px] text-[12px] text-muted-foreground"
              >
                <span className="min-w-0 flex-1">{t('createProject.recovery.stored')}</span>
                <Button
                  type="button"
                  variant="ghost"
                  className={clientWorkbenchButtonClassName}
                  data-testid="create-project-query-stored"
                  disabled={querying}
                  onClick={() => { void creator.queryReceipt() }}
                >
                  {t('createProject.recovery.queryAction')}
                </Button>
              </div>
            ) : null}

            {submitError && submitError.kind === 'unresolved' ? (
              <div
                role="alert"
                data-testid="create-project-submit-unresolved"
                className="mb-[12px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
              >
                {t('createProject.recovery.description')}
              </div>
            ) : null}
            {submitError && submitError.kind === 'definite' && !showEnterpriseExists && !showPhoneVerification ? (
              <div
                role="alert"
                data-testid="create-project-submit-error"
                className="mb-[12px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
              >
                {submitMessageKey ? t(submitMessageKey) : t('createProject.error.generic')}
              </div>
            ) : null}
            {showEnterpriseExists ? (
              <div
                role="alert"
                data-testid="create-project-enterprise-exists"
                className="mb-[12px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
              >
                <span>{t('createProject.error.enterpriseExists')}</span>
                {existingEnterpriseSpace ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className={clientWorkbenchButtonClassName + ' mt-[8px]'}
                    data-testid="create-project-enter-existing"
                    onClick={() => {
                      onOpenChange(false)
                      if (existingEnterpriseSpace.id !== space.activeProductSpaceId) {
                        space.onSelectProductSpace(existingEnterpriseSpace.id)
                      }
                    }}
                  >
                    {t('createProject.error.enterpriseExistsAction')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {showPhoneVerification ? (
              <div
                role="alert"
                data-testid="create-project-phone-verification"
                className="mb-[12px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
              >
                <span>{t('createProject.error.phoneVerification')}</span>
                <Button
                  type="button"
                  variant="ghost"
                  className={clientWorkbenchButtonClassName + ' mt-[8px]'}
                  data-testid="create-project-verify-phone"
                  onClick={onVerifyPhone}
                >
                  {t('createProject.error.phoneVerificationAction')}
                </Button>
              </div>
            ) : null}

            <div className="flex flex-col gap-[12px]">
              <label className="block">
                <span className="mb-[5px] block text-[12px] font-medium text-foreground">
                  {t('createProject.field.nameLabel')}
                </span>
                <Input
                  ref={nameInputRef}
                  data-testid="create-project-name-input"
                  value={values.name}
                  maxLength={presentation.fieldLimits.nameMax}
                  placeholder={t('createProject.field.namePlaceholder')}
                  disabled={phase === 'submitting'}
                  onChange={event => creator.setField('name', event.target.value)}
                  aria-invalid={Boolean(fieldErrors.name)}
                  aria-describedby="create-project-name-hint"
                />
                <span id="create-project-name-hint" className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
                  {fieldErrors.name ? t(fieldErrors.name) : t('createProject.field.nameHint')}
                </span>
              </label>
              <label className="block">
                <span className="mb-[5px] block text-[12px] font-medium text-foreground">
                  {t('createProject.field.ownerLabel')}
                </span>
                <Input
                  data-testid="create-project-owner-input"
                  value={values.ownerName}
                  maxLength={presentation.fieldLimits.ownerNameMax}
                  placeholder={t('createProject.field.ownerPlaceholder')}
                  disabled={phase === 'submitting'}
                  onChange={event => creator.setField('ownerName', event.target.value)}
                  aria-invalid={Boolean(fieldErrors.ownerName)}
                  aria-describedby="create-project-owner-hint"
                />
                <span id="create-project-owner-hint" className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
                  {fieldErrors.ownerName ? t(fieldErrors.ownerName) : t('createProject.field.ownerHint')}
                </span>
              </label>
              <label className="block">
                <span className="mb-[5px] block text-[12px] font-medium text-foreground">
                  {t('createProject.field.purposeLabel')}
                </span>
                <Textarea
                  data-testid="create-project-purpose-input"
                  value={values.purpose}
                  maxLength={presentation.fieldLimits.purposeMax}
                  placeholder={t('createProject.field.purposePlaceholder')}
                  rows={3}
                  disabled={phase === 'submitting'}
                  onChange={event => creator.setField('purpose', event.target.value)}
                  aria-invalid={Boolean(fieldErrors.purpose)}
                />
                <span className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
                  {fieldErrors.purpose ? t(fieldErrors.purpose) : ''}
                </span>
              </label>
            </div>

            <p className="mt-[14px] rounded-[10px] border border-border bg-foreground-5 px-[12px] py-[10px] text-[12px] leading-[1.55] text-foreground-60" data-testid="create-project-budget-fact">
              {t('createProject.budgetFact')}
            </p>

            <div className="mt-[12px]">
              <label className="flex cursor-pointer items-start gap-[9px]" data-testid="create-project-responsibility">
                <Checkbox
                  checked={values.responsibilityConfirmed}
                  disabled={phase === 'submitting'}
                  onChange={event => creator.setResponsibilityConfirmed(event.target.checked)}
                  className="mt-[2px]"
                />
                <span className="text-[12px] font-medium leading-[1.55] text-foreground">
                  {t('createProject.responsibilityConfirm')}
                </span>
              </label>
              <span className="mt-[4px] block text-[11px] leading-[1.45] text-destructive">
                {fieldErrors.responsibility ? t(fieldErrors.responsibility) : ''}
              </span>
              {versionMismatch ? (
                <p className="mt-[2px] text-[11px] leading-[1.45] text-destructive" data-testid="create-project-version-mismatch" role="alert">
                  {t('createProject.responsibilityMismatch')}
                </p>
              ) : null}
            </div>
          </form>
        ) : null}

        <DialogFooter>
          {phase === 'created' ? (
            <Button
              type="button"
              className={clientWorkbenchPrimaryClassName}
              data-testid="create-project-retry-enter"
              disabled={entering}
              onClick={() => { if (outcome) void enterCreatedProject(outcome.productSpaceId) }}
            >
              {t('createProject.created.retryEnter')}
            </Button>
          ) : phase === 'recovery' ? (
            <>
              <Button
                type="button"
                variant="ghost"
                className={clientWorkbenchButtonClassName}
                data-testid="create-project-back-to-form"
                onClick={creator.backToForm}
              >
                {t('common.close')}
              </Button>
              <Button
                type="button"
                className={clientWorkbenchPrimaryClassName}
                data-testid="create-project-query-receipt"
                disabled={querying}
                onClick={() => { void creator.queryReceipt() }}
              >
                {querying ? t('createProject.submitting') : t('createProject.recovery.queryAction')}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                className={clientWorkbenchButtonClassName}
                data-testid="create-project-cancel"
                disabled={phase === 'submitting'}
                onClick={() => handleOpenChange(false)}
              >
                {t('common.cancel')}
              </Button>
              {formVisible ? (
                <Button
                  type="submit"
                  form="create-project-form"
                  className={clientWorkbenchPrimaryClassName}
                  data-testid="create-project-submit"
                  disabled={phase === 'submitting'}
                >
                  {phase === 'submitting'
                    ? t('createProject.submitting')
                    : t('createProject.submit')}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
