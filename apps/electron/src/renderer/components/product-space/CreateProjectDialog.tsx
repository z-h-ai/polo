import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Loader2 } from 'lucide-react'
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
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchDialogClassName,
  clientWorkbenchOverlayClassName,
  clientWorkbenchPrimaryClassName,
  useClientWorkbenchStyle,
} from '@/components/ui/client-workbench'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { useProjectLightweightEntry } from '../projects/enter-project'
import type { ProjectSummary } from '@polo-ai/shared/protocol'
import { useCreateProject } from './useCreateProject'

/**
 * POO-205 minimal create-project dialog (Spec Q1/Q3: a project is a
 * lightweight entity INSIDE an organization).
 *
 * One shared instance hosted by App next to the product-space switch dialog;
 * the home「项目」区域 is the only entry. The form is name (required,
 * autofocus) + optional purpose — NO owner name (the acting account owns the
 * project by construction), NO payment responsibility consent, NO phone
 * verification, NO idempotency key or receipt query (the whole POO-196
 * client-side-enterprise surface is retired; polo-admin decides authority).
 *
 * The command only exists while an ORGANIZATION space is committed
 * (`pm:createProject` is committed-organization scoped). With the personal
 * space committed the dialog renders the guidance face: an explicit「前往
 * 组织空间」action when this account has exactly one organization, a neutral
 * hint otherwise — never a form that can only fail.
 *
 * HIG (retained): single primary action; Enter submits only when the form
 * validates; an IME composition Enter (isComposing / keyCode 229) never
 * submits; Escape cannot dismiss an in-flight submit; errors sit next to
 * their field; success is the created PROJECT — the dialog closes and the
 * lightweight entry lands the project home (never a space switch here: the
 * organization is already the committed space).
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Success continuation — the lightweight project entry. Injected so the
   * production wiring and isolated tests share one surface; the dialog never
   * navigates on its own beyond handing the project over. */
  onCreated?: (accountId: string, project: ProjectSummary) => void
}) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const space = useProductSpaceContext()
  const { enterProject } = useProjectLightweightEntry()
  const accountId = space.accountId

  // The committed-organization scope: creation exists only here. Personal
  // spaces have no project scope and never render the form.
  const committed = space.activeProductSpace
  const orgScope = committed?.kind === 'enterprise'
    ? { accountId, productSpaceId: committed.id, organizationEnterpriseId: committed.enterpriseId }
    : null

  // The「前往组织空间」guidance targets THE one organization of this account;
  // with several, the neutral hint stands (choosing for the user would be a
  // hidden space switch).
  const soleOrgSpace = space.productSpaces.find(item => item.kind === 'enterprise') ?? null
  const hasMultipleOrgs = space.productSpaces.filter(item => item.kind === 'enterprise').length > 1

  const creator = useCreateProject(orgScope)
  const { phase, values, fieldErrors, submitErrorKey } = creator

  const nameInputRef = useRef<HTMLInputElement>(null)

  const handleCreated = useCallback((project: ProjectSummary) => {
    creator.reset()
    onOpenChange(false)
    if (onCreated) {
      onCreated(accountId, project)
      return
    }
    void enterProject(accountId, project)
  }, [accountId, creator, enterProject, onCreated, onOpenChange])

  const runSubmit = useCallback(() => {
    if (phase !== 'form') return
    void creator.submit().then(project => {
      if (project) handleCreated(project)
    })
  }, [creator, handleCreated, phase])

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) creator.reset()
    onOpenChange(next)
  }, [creator, onOpenChange])

  // D7 (retained): an Enter that only confirms an IME composition is text
  // input, not a submit intent.
  const handleFormKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.nativeEvent?.isComposing || event.nativeEvent.keyCode === 229)) {
      event.preventDefault()
    }
  }, [])

  // Fresh open → the name field, always (the form resets on close).
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => nameInputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  const formVisible = Boolean(orgScope) && phase === 'form'
  const submitting = phase === 'submitting'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="create-project-dialog"
        data-phase={phase}
        style={workbenchStyle}
        overlayStyle={workbenchStyle}
        overlayClassName={clientWorkbenchOverlayClassName}
        className={clientWorkbenchDialogClassName}
        onEscapeKeyDown={event => { if (submitting) event.preventDefault() }}
        onInteractOutside={event => { if (submitting) event.preventDefault() }}
        showCloseButton={!submitting}
        onOpenAutoFocus={event => {
          event.preventDefault()
          nameInputRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle data-testid="create-project-title">{t('createProject.title')}</DialogTitle>
          <DialogDescription>{t('createProject.description')}</DialogDescription>
        </DialogHeader>

        {!orgScope ? (
          // Personal space committed: no project scope exists here. The
          // guidance face never renders a form that can only fail.
          <div className="flex flex-col items-center gap-[12px] px-[20px] pb-[10px] pt-[4px]" data-testid="create-project-org-required">
            <span className="grid size-[44px] place-items-center rounded-[12px] bg-[var(--info-soft)] text-info" aria-hidden="true">
              <Building2 className="size-[22px]" />
            </span>
            <p className="m-0 text-center text-[13px] leading-[1.6] text-muted-foreground">
              {hasMultipleOrgs
                ? t('poo205.create.orgRequiredMulti')
                : t('poo205.create.orgRequired')}
            </p>
            {soleOrgSpace && !hasMultipleOrgs ? (
              <Button
                type="button"
                className={clientWorkbenchPrimaryClassName}
                data-testid="create-project-go-organization"
                onClick={() => {
                  handleOpenChange(false)
                  if (soleOrgSpace.id !== space.activeProductSpaceId) {
                    space.onSelectProductSpace(soleOrgSpace.id)
                  }
                }}
              >
                {t('poo205.create.goOrganization', { name: soleOrgSpace.name })}
              </Button>
            ) : null}
          </div>
        ) : (
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
            {submitErrorKey ? (
              <div
                role="alert"
                data-testid="create-project-submit-error"
                className="mb-[12px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
              >
                {t(submitErrorKey)}
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
                  maxLength={creator.fieldLimits.nameMax}
                  placeholder={t('createProject.field.namePlaceholder')}
                  disabled={submitting}
                  onChange={event => creator.setField('name', event.target.value)}
                  aria-invalid={Boolean(fieldErrors.name)}
                  aria-describedby="create-project-name-hint"
                />
                <span id="create-project-name-hint" className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
                  {fieldErrors.name ? t(fieldErrors.name, { max: creator.fieldLimits.nameMax }) : ''}
                </span>
              </label>
              <label className="block">
                <span className="mb-[5px] block text-[12px] font-medium text-foreground">
                  {t('createProject.field.purposeOptional')}
                </span>
                <Textarea
                  data-testid="create-project-purpose-input"
                  value={values.purpose}
                  maxLength={creator.fieldLimits.purposeMax}
                  placeholder={t('createProject.field.purposePlaceholder')}
                  rows={2}
                  disabled={submitting}
                  onChange={event => creator.setField('purpose', event.target.value)}
                  aria-invalid={Boolean(fieldErrors.purpose)}
                  aria-describedby="create-project-purpose-hint"
                />
                <span id="create-project-purpose-hint" className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
                  {fieldErrors.purpose ? t(fieldErrors.purpose, { max: creator.fieldLimits.purposeMax }) : ''}
                </span>
              </label>
            </div>
          </form>
        )}

        {orgScope ? (
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className={clientWorkbenchButtonClassName}
              data-testid="create-project-cancel"
              disabled={submitting}
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
                disabled={submitting}
              >
                {submitting
                  ? (
                    <span className="inline-flex items-center gap-[6px]">
                      <Loader2 className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      {t('createProject.submitting')}
                    </span>
                  )
                  : t('createProject.submit')}
              </Button>
            ) : null}
          </DialogFooter>
        ) : (
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className={clientWorkbenchButtonClassName}
              data-testid="create-project-close"
              onClick={() => handleOpenChange(false)}
            >
              {t('common.close')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
