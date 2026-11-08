import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchPrimaryClassName,
} from '@/components/ui/client-workbench'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { updateProjectInput } from './projects-api'
import type { PmOrganizationScopeInput, ProjectSummary } from '@polo-ai/shared/protocol'

/**
 * POO-205 项目设置 view (settings视图) — edit the project's name / purpose /
 * instructions (PATCH semantics via `pm:updateProject`: absent fields stay
 * unchanged; clearing purpose/instructions sends the empty string and the
 * server normalizes it to absent). Owner/manager authority is decided by
 * polo-admin on the wire — the view still only offers the form to roles that
 * can plausibly save, and a `prj_forbidden` answer surfaces as an explicit
 * error instead of a silent no-op.
 */
export function ProjectSettingsView({ project, onSaved }: {
  project: ProjectSummary
  /** Success continuation — the fresh ProjectSummary (name/purpose may have
   * changed; the nav list re-reads on next mount). */
  onSaved: (project: ProjectSummary) => void
}) {
  const { t } = useTranslation()
  const space = useProductSpaceContext()
  const committed = space.activeProductSpace
  const orgScope: PmOrganizationScopeInput | null = committed?.kind === 'enterprise'
    ? {
      accountId: space.accountId,
      productSpaceId: committed.id,
      organizationEnterpriseId: committed.enterpriseId,
    }
    : null

  const canManage = project.myRole === 'owner' || project.myRole === 'manager'
  const [name, setName] = useState(project.name)
  const [purpose, setPurpose] = useState(project.purpose ?? '')
  const [instructions, setInstructions] = useState(project.instructions ?? '')
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; purpose?: string; instructions?: string }>({})
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const generationRef = useRef(0)

  // A different project's settings must never inherit this form's draft.
  useEffect(() => {
    generationRef.current += 1
    setName(project.name)
    setPurpose(project.purpose ?? '')
    setInstructions(project.instructions ?? '')
    setFieldErrors({})
    setErrorKey(null)
    setSaving(false)
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps -- the draft resets on the PROJECT identity, not on every summary refresh

  const dirty = useMemo(() => (
    name !== project.name
    || purpose !== (project.purpose ?? '')
    || instructions !== (project.instructions ?? '')
  ), [instructions, name, project.instructions, project.name, project.purpose, purpose])

  const save = useCallback(async () => {
    if (!orgScope || saving) return
    const errors: typeof fieldErrors = {}
    const trimmedName = name.trim()
    if (!trimmedName) errors.name = 'createProject.error.nameRequired'
    setFieldErrors(errors)
    if (Object.values(errors).some(Boolean)) return
    const generation = ++generationRef.current
    setSaving(true)
    setErrorKey(null)
    try {
      const response = await window.electronAPI.pmUpdateProject(updateProjectInput(orgScope, project.id, {
        // PATCH semantics: empty string clears; only CHANGED fields travel.
        ...(trimmedName !== project.name ? { name: trimmedName } : {}),
        ...(purpose !== (project.purpose ?? '') ? { purpose } : {}),
        ...(instructions !== (project.instructions ?? '') ? { instructions } : {}),
      }))
      if (generation !== generationRef.current) return
      onSaved(response.project)
    } catch {
      if (generation !== generationRef.current) return
      setErrorKey('poo205.settings.saveFailed')
    } finally {
      if (generation === generationRef.current) setSaving(false)
    }
  }, [instructions, name, onSaved, orgScope, project.id, project.instructions, project.name, project.purpose, purpose, saving])

  if (!canManage) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-[10px] px-[20px] py-[30px] text-center" data-testid="project-settings-forbidden">
        <p className="m-0 max-w-[320px] text-[13px] leading-[1.6] text-muted-foreground">
          {t('poo205.settings.forbidden')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto px-[16px] pb-[16px]" data-testid="project-settings-view">
      {errorKey ? (
        <div
          role="alert"
          data-testid="project-settings-error"
          className="flex items-start gap-[8px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
        >
          <AlertCircle className="mt-[2px] size-[14px] shrink-0" aria-hidden="true" />
          <span>{t(errorKey)}</span>
        </div>
      ) : null}

      <label className="block shrink-0">
        <span className="mb-[5px] block text-[12px] font-medium text-foreground">
          {t('createProject.field.nameLabel')}
        </span>
        <Input
          data-testid="project-settings-name"
          value={name}
          maxLength={256}
          disabled={saving}
          onChange={event => setName(event.target.value)}
          aria-invalid={Boolean(fieldErrors.name)}
        />
        <span className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
          {fieldErrors.name ? t(fieldErrors.name) : ''}
        </span>
      </label>

      <label className="block shrink-0">
        <span className="mb-[5px] block text-[12px] font-medium text-foreground">
          {t('createProject.field.purposeOptional')}
        </span>
        <Textarea
          data-testid="project-settings-purpose"
          value={purpose}
          maxLength={2000}
          rows={3}
          disabled={saving}
          placeholder={t('poo205.settings.purposePlaceholder')}
          onChange={event => setPurpose(event.target.value)}
        />
      </label>

      <label className="block shrink-0">
        <span className="mb-[5px] block text-[12px] font-medium text-foreground">
          {t('poo205.settings.instructionsLabel')}
        </span>
        <Textarea
          data-testid="project-settings-instructions"
          value={instructions}
          maxLength={8192}
          rows={6}
          disabled={saving}
          placeholder={t('poo205.settings.instructionsPlaceholder')}
          onChange={event => setInstructions(event.target.value)}
        />
        <span className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
          {t('poo205.settings.instructionsHint')}
        </span>
      </label>

      <div className="mt-auto flex shrink-0 items-center justify-end gap-2">
        {saving ? (
          <span className="mr-auto inline-flex items-center gap-[6px] text-[12px] text-muted-foreground" data-testid="project-settings-saving">
            <Loader2 className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t('createProject.submitting')}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className={clientWorkbenchButtonClassName}
          data-testid="project-settings-reset"
          disabled={saving || !dirty}
          onClick={() => {
            generationRef.current += 1
            setName(project.name)
            setPurpose(project.purpose ?? '')
            setInstructions(project.instructions ?? '')
            setFieldErrors({})
            setErrorKey(null)
          }}
        >
          {t('poo205.settings.reset')}
        </Button>
        <Button
          type="button"
          className={clientWorkbenchPrimaryClassName}
          data-testid="project-settings-save"
          disabled={saving || !dirty}
          onClick={() => { void save() }}
        >
          {t('poo205.settings.save')}
        </Button>
      </div>
    </div>
  )
}
