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
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { useProjectEntry } from '@/hooks/useProjectEntry'
import { navigate, routes } from '@/lib/navigate'
import { useCreateProject } from './useCreateProject'

/**
 * POO-196 R3 minimal create-project dialog (consensus P5, adjudication D7).
 *
 * One shared instance hosted by App next to the product-space switch dialog —
 * the home「项目」区域 is the only entry (P11) — and the component stays
 * mounted so a lost-response recovery and an in-flight submit survive closing
 * the dialog (D-B 6: closing the view never implies the server write was
 * cancelled — the stored key keeps the receipt queryable).
 *
 * R3 form surface: title (required, autofocus) + optional introduction only.
 * There is NO standing owner-name input — the current account's effective
 * display name (App shell admin user) is the owner automatically; the
 * 「你的姓名」completion field appears ONLY when that name is blank or over
 * the 64-code-unit bound, with the "syncs to the account display name"
 * disclosure (admin create-service writes ownerName into user.displayName —
 * the member must know). The payment responsibility consent is a single
 * checkbox: a 13px fact line with an info icon sits ABOVE the consent (U1 —
 * no-prepayment / budget-off-by-default facts, no promises beyond C1), and
 * the full responsibility sentence stays intact below it.
 *
 * HIG (retained): single primary action; Enter submits only when the form
 * validates AND the responsibility checkbox is explicitly checked; an IME
 * composition Enter (isComposing / keyCode 229) never submits; Escape closes
 * an uncommitted step (an in-flight submit is protected against dismissal —
 * X2-5); errors sit next to their field; the "created" state is separate from
 * the "entered" state and never re-creates. Reopening never carries the
 * previous consent (E2-3/D-B 1): the checkbox returns to its unchecked
 * default.
 */

function submitErrorKey(code: string | null): string {
  switch (code) {
    case 'phone_verification_required':
      return 'createProject.error.phoneVerification'
    case 'account_enterprise_exists':
      return 'createProject.error.enterpriseExists'
    case 'idempotency_conflict':
      return 'createProject.error.conflict'
    // D7: the admin deployment pre-dates the r3 negotiation (unknown contract
    // version → 409). Definite, never resolved by retrying the same wire.
    case 'contract_version_unsupported':
      return 'createProject.error.versionUnsupported'
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
  // P5/D7 owner-name source: the signed-in account's display name comes from
  // the App shell's admin user (App-owned; optional so isolated mounts simply
  // fall into the completion case). Never the username — D7 forbids standing
  // in for a missing display name.
  const accountDisplayName = useOptionalAppShellContext()?.currentAdminUser?.displayName ?? null
  const accountId = space.accountId
  // R3 (D13): the create-success auto-enter rides the project-entry flow.
  const { enterProject } = useProjectEntry()
  const creator = useCreateProject(accountId, accountDisplayName)
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
    ownerNeedsInput,
  } = creator

  const [enterFailed, setEnterFailed] = useState(false)
  const [entering, setEntering] = useState(false)
  // U4: the version-unsupported error face carries an expandable local guide
  // (「查看更新指引」→ explanation block, collapsible, keyboard operable). It
  // starts collapsed on every fresh submit and never mutates the form state.
  const [versionGuideOpen, setVersionGuideOpen] = useState(false)
  // U4: the「检查客户端更新」shortcut opens the App shell's existing settings
  // app page. It renders ONLY when the hosting shell provides settings
  // navigation (the AppShell context owner); a host without it keeps just the
  // expandable local guide — never a dead button.
  const settingsNavigationAvailable = useOptionalAppShellContext() !== null
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
      // the next open — reopening offers a fresh consent (E2-3: the
      // responsibility checkbox never survives), the text draft stays, or the
      // D-B 6 recovery query when a stored key remains).
      creator.reset()
      onOpenChange(false)
      // R3 (D13): enter through the project-entry flow — committed switch →
      // most recent conversation (none: the editable empty state) → visit
      // record. The refreshed list is passed explicitly: the context value
      // may still hold the pre-refresh spaces when this continuation runs.
      // A failed entry shows「项目已创建，暂时无法进入」and the retry NEVER
      // re-creates (the outcome stays queryable server-side). U3/U10: the
      // create ORIGIN rides the shared entry state so failure faces can add
      // the「项目已创建，暂时无法进入」line.
      enterProject(productSpaceId, { knownSpaces: list ?? undefined, origin: 'create' })
    } catch {
      setEnterFailed(true)
    } finally {
      setEntering(false)
    }
  }, [creator.reset, enterProject, onOpenChange, space])

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
    // U4: a fresh submit starts with the version guide collapsed again.
    setVersionGuideOpen(false)
    void creator.submit().then(result => {
      if (result) setEnterFailed(false)
    })
  }, [creator, entering, phase])

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      // Escape / close always closes an uncommitted step. An in-flight submit
      // keeps its stored key: reopening offers「查询创建结果」(D-B 6) — the
      // view closing never implies the server write was cancelled.
      setVersionGuideOpen(false)
      creator.reset()
    }
    onOpenChange(next)
  }, [creator, onOpenChange])

  // D7: an Enter that only confirms an IME composition (isComposing, or the
  // Safari/Chrome keyCode 229 marker) is text input, not a submit intent.
  const handleFormKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.nativeEvent?.isComposing || event.nativeEvent.keyCode === 229)) {
      event.preventDefault()
    }
  }, [])

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
        // X2-5 (consensus 方案 A): an in-flight submit cannot be dismissed —
        // Escape / clicking outside / the X would silently drop the ONLY
        // callback that can still route the result, and a closed dialog gives
        // no way to see the outcome. The stored key keeps recovery available
        // afterwards, but blocking is the honest surface while writing.
        onEscapeKeyDown={event => { if (phase === 'submitting') event.preventDefault() }}
        onInteractOutside={event => { if (phase === 'submitting') event.preventDefault() }}
        showCloseButton={phase !== 'submitting'}
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
            onKeyDown={handleFormKeyDown}
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
                {/* U4: `contract_version_unsupported` is a service-contract
                negotiation failure — retrying the same wire cannot fix it, so
                the face offers an expandable local guide instead of a retry.
                The explanation stays inside THIS error block; the「检查客户端
               更新」shortcut only renders when the hosting shell provides the
                existing settings navigation, and it never claims an update
                happened (客户端更新不等于服务已更新). */}
                {submitError.code === 'contract_version_unsupported' && (
                  <div className="mt-[8px]">
                    <button
                      type="button"
                      data-testid="create-project-update-guide"
                      aria-expanded={versionGuideOpen}
                      className="inline-flex min-h-[28px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
                      onClick={() => setVersionGuideOpen(open => !open)}
                    >
                      {versionGuideOpen ? t('home.projects.collapse') : t('home.projects.updateGuideAction')}
                    </button>
                    {versionGuideOpen && (
                      <div data-testid="create-project-update-guide-body" className="mt-[8px] text-[12px] leading-[1.55]">
                        <p className="m-0 text-destructive">{t('home.projects.updateGuideBody')}</p>
                        {settingsNavigationAvailable && (
                          <div className="mt-[8px]">
                            <Button
                              type="button"
                              variant="ghost"
                              className={clientWorkbenchButtonClassName}
                              data-testid="create-project-client-update"
                              onClick={() => navigate(routes.view.settings('app'))}
                            >
                              {t('home.projects.clientUpdateAction')}
                            </Button>
                            <p className="m-0 mt-[4px] text-[11px] leading-[1.45] text-muted-foreground">
                              {t('home.projects.clientUpdateNote')}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null}
            {showEnterpriseExists ? (
              // P6/D2: after the r3 capacity guard this branch no longer fires
              // for client project creation (an organization membership no
              // longer blocks a new project). Kept as a DEFENSIVE surface for
              // a server that still answers the legacy code.
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
                {/* U1: the standing hint under the name field is retired —
                the dialog introduction carries the honest invitation copy and
                the hint key keeps its synced value without re-rendering it
                here. Field errors still appear in place. */}
                <span id="create-project-name-hint" className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
                  {fieldErrors.name ? t(fieldErrors.name, { max: presentation.fieldLimits.nameMax }) : ''}
                </span>
              </label>
              {ownerNeedsInput ? (
                // P5/D7: the ONLY owner-name surface — the completion field for
                // a missing or over-limit account display name. A usable
                // display name never renders an input here.
                <label className="block">
                  <span className="mb-[5px] block text-[12px] font-medium text-foreground">
                    {t('createProject.field.yourName')}
                  </span>
                  <Input
                    data-testid="create-project-owner-input"
                    value={values.ownerName}
                    maxLength={presentation.fieldLimits.ownerNameMax}
                    placeholder={t('createProject.field.ownerPlaceholder')}
                    disabled={phase === 'submitting'}
                    onChange={event => creator.setField('ownerName', event.target.value)}
                    aria-invalid={Boolean(fieldErrors.ownerName)}
                    aria-describedby="create-project-owner-sync-hint"
                  />
                  <span id="create-project-owner-sync-hint" data-testid="create-project-owner-sync-hint" className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
                    {t('createProject.field.nameSyncHint')}
                  </span>
                  {fieldErrors.ownerName ? (
                    <span className="mt-[2px] block text-[11px] leading-[1.45] text-destructive">
                      {t(fieldErrors.ownerName, { max: presentation.fieldLimits.ownerNameMax })}
                    </span>
                  ) : null}
                </label>
              ) : null}
              <label className="block">
                <span className="mb-[5px] block text-[12px] font-medium text-foreground">
                  {t('createProject.field.purposeOptional')}
                </span>
                <Textarea
                  data-testid="create-project-purpose-input"
                  value={values.purpose}
                  maxLength={presentation.fieldLimits.purposeMax}
                  placeholder={t('createProject.field.purposePlaceholder')}
                  rows={2}
                  disabled={phase === 'submitting'}
                  onChange={event => creator.setField('purpose', event.target.value)}
                  aria-invalid={Boolean(fieldErrors.purpose)}
                  // X2-18: the error text is reachable as THIS control's
                  // description, matching the name field pattern.
                  aria-describedby="create-project-purpose-hint"
                />
                <span id="create-project-purpose-hint" className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
                  {fieldErrors.purpose ? t(fieldErrors.purpose, { max: presentation.fieldLimits.purposeMax }) : ''}
                </span>
              </label>
            </div>

            {/* 产品裁决（用户 2026-11-06）：预算/预充值说明行移除——不同意
            任何「不收费/默认关闭」类承诺文案。POL-79 的显式勾选保留（勾选
            本体是命令事实，不可静默代为同意），标签按用户意见最短化。 */}
            <div className="mt-[10px]">
              {/* U1: the FULL original responsibility sentence stays intact
              (never split up, never replaced by a soothing paraphrase) and the
              whole label is the click target — the native label wraps the
              24px box, so clicking any part toggles the consent exactly once. */}
              <label className="flex cursor-pointer items-start gap-[9px]" data-testid="create-project-responsibility">
                <Checkbox
                  checked={values.responsibilityConfirmed}
                  disabled={phase === 'submitting'}
                  onChange={event => creator.setResponsibilityConfirmed(event.target.checked)}
                  aria-invalid={Boolean(fieldErrors.responsibility)}
                  aria-describedby={fieldErrors.responsibility ? 'create-project-responsibility-error' : undefined}
                  className="mt-[1px] size-[24px]"
                />
                <span className="text-[12px] leading-[1.55] text-foreground">
                  {t('createProject.responsibilityConfirm')}
                </span>
              </label>
              {fieldErrors.responsibility ? (
                // U1: the unchecked-submit error carries its own icon (≥12px)
                // and is wired to the checkbox via aria-describedby.
                <span id="create-project-responsibility-error" data-testid="create-project-responsibility-error" className="mt-[6px] flex items-start gap-[6px] text-[12px] leading-[1.45] text-destructive">
                  <AlertCircle className="mt-[1px] size-[12px] shrink-0" aria-hidden="true" />
                  <span>{t(fieldErrors.responsibility)}</span>
                </span>
              ) : null}
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
                {/* E2-6: a REAL exit back to the form — the stored banner
                    there offers the query and the unchanged re-submit. */}
                {t('createProject.recovery.backToForm')}
              </Button>
              <Button
                type="button"
                className={clientWorkbenchPrimaryClassName}
                data-testid="create-project-query-receipt"
                disabled={querying}
                onClick={() => { void creator.queryReceipt() }}
              >
                {/* X2-6: querying is a READ — the verb must not re-claim the
                    create action in a payment-responsibility context. */}
                {querying ? t('createProject.recovery.querying') : t('createProject.recovery.queryAction')}
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
