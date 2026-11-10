import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchPrimaryClassName,
} from '@/components/ui/client-workbench'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { PROJECT_INSTRUCTIONS_MAX_CHARS, PROJECT_NAME_MAX_CHARS, PROJECT_PURPOSE_MAX_CHARS } from '@polo-ai/shared/protocol'
import type { PmOrganizationScopeInput, ProjectSummary } from '@polo-ai/shared/protocol'
import { updateProjectInput, projectActionErrorKeyOf } from './projects-api'

/**
 * POO-205 项目设置 view (settings视图) — edit the project's name / purpose /
 * instructions (PATCH semantics via `pm:updateProject`: absent fields stay
 * unchanged; clearing purpose/instructions sends the empty string and the
 * server normalizes it to absent). Owner/manager authority is decided by
 * polo-admin on the wire — the view still only offers the form to roles that
 * can plausibly save, and a `prj_*` answer surfaces through the shared
 * pm error mapping instead of a silent no-op.
 *
 * C8 (R8): the dialog was REDONE for the project-tab sidebar entry —
 * per-field length counters (256/2000/8192, the contract constants), a
 * success toast on a landed save, and a MEMBER face that is a real READ-ONLY
 * view of the full instructions (the R7 adjudication: 成员角色打开时指令只读
 * 视图可见全文) instead of the old forbidden dead-end. The caller supplies
 * `canManage` from the member-panel source (the roster's viewer role); the
 * tab-carried `myRole` only fills in before the roster has spoken.
 */

export function ProjectSettingsView({ project, canManage, onSaved }: {
  project: ProjectSummary
  /** Edit authority, resolved by the CALLER from the live member roster
   * (the member-panel source). False renders the read-only view. When
   * omitted the view falls back to the summary's own role. */
  canManage?: boolean
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

  const effectiveCanManage = canManage ?? (project.myRole === 'owner' || project.myRole === 'manager')
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
      toast.success(t('projectSettings.saved'))
      onSaved(response.project)
    } catch (error) {
      if (generation !== generationRef.current) return
      // C8: pm wire codes map through the shared pm presentation — never a
      // raw code, and a prj_forbidden is exactly what it says.
      setErrorKey(projectActionErrorKeyOf(error))
    } finally {
      if (generation === generationRef.current) setSaving(false)
    }
  }, [instructions, name, onSaved, orgScope, project.id, project.instructions, project.name, project.purpose, purpose, saving, t])

  // C8 R7: a member sees the project as it IS — every field, instructions in
  // full — with no editing affordance. The advisory names the authority, it
  // never hides the content.
  if (!effectiveCanManage) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto px-[4px] pb-[4px]" data-testid="project-settings-readonly">
        <p
          role="note"
          data-testid="project-settings-readonly-hint"
          className="m-0 flex items-start gap-[8px] rounded-[10px] bg-foreground-5 px-[12px] py-[10px] text-[12px] leading-[1.55] text-muted-foreground"
        >
          <AlertCircle className="mt-[2px] size-[14px] shrink-0" aria-hidden="true" />
          <span>{t('poo205.settings.forbidden')}</span>
        </p>
        <ReadOnlyField label={t('createProject.field.nameLabel')} value={project.name} testId="project-settings-readonly-name" />
        {project.purpose ? (
          <ReadOnlyField label={t('createProject.field.purposeOptional')} value={project.purpose} testId="project-settings-readonly-purpose" />
        ) : null}
        <ReadOnlyField
          label={t('poo205.settings.instructionsLabel')}
          value={project.instructions ?? ''}
          testId="project-settings-readonly-instructions"
          multiline={true}
          emptyText={t('poo205.settings.instructionsHint')}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto px-[4px] pb-[4px]" data-testid="project-settings-view">
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
        <span className="mb-[5px] flex items-baseline justify-between gap-[8px]">
          <span className="text-[12px] font-medium text-foreground">
            {t('createProject.field.nameLabel')}
          </span>
          <CharCounter value={name.length} max={PROJECT_NAME_MAX_CHARS} testId="project-settings-name-count" />
        </span>
        <Input
          data-testid="project-settings-name"
          value={name}
          maxLength={PROJECT_NAME_MAX_CHARS}
          disabled={saving}
          onChange={event => setName(event.target.value)}
          aria-invalid={Boolean(fieldErrors.name)}
        />
        <span className="mt-[4px] block text-[11px] leading-[1.45] text-foreground-50">
          {fieldErrors.name ? t(fieldErrors.name) : ''}
        </span>
      </label>

      <label className="block shrink-0">
        <span className="mb-[5px] flex items-baseline justify-between gap-[8px]">
          <span className="text-[12px] font-medium text-foreground">
            {t('createProject.field.purposeOptional')}
          </span>
          <CharCounter value={purpose.length} max={PROJECT_PURPOSE_MAX_CHARS} testId="project-settings-purpose-count" />
        </span>
        <Textarea
          data-testid="project-settings-purpose"
          value={purpose}
          maxLength={PROJECT_PURPOSE_MAX_CHARS}
          rows={3}
          disabled={saving}
          placeholder={t('poo205.settings.purposePlaceholder')}
          onChange={event => setPurpose(event.target.value)}
        />
      </label>

      <label className="block shrink-0">
        <span className="mb-[5px] flex items-baseline justify-between gap-[8px]">
          <span className="text-[12px] font-medium text-foreground">
            {t('poo205.settings.instructionsLabel')}
          </span>
          <CharCounter value={instructions.length} max={PROJECT_INSTRUCTIONS_MAX_CHARS} testId="project-settings-instructions-count" />
        </span>
        <Textarea
          data-testid="project-settings-instructions"
          value={instructions}
          maxLength={PROJECT_INSTRUCTIONS_MAX_CHARS}
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

/** C8: the per-field 「n / max」 counter — contract constants, not literals. */
function CharCounter({ value, max, testId }: { value: number; max: number; testId: string }) {
  const { t } = useTranslation()
  return (
    <span
      data-testid={testId}
      aria-live="off"
      className="shrink-0 text-[11px] leading-[1.45] tabular-nums text-foreground-50"
    >
      {t('projectSettings.charCount', { count: value, max })}
    </span>
  )
}

/** The read-only face's field: the value in full (pre-wrap for the
 * instructions), an explicit 「未设置」 for absent optionals. */
function ReadOnlyField({ label, value, testId, multiline = false, emptyText }: {
  label: string
  value: string
  testId: string
  multiline?: boolean
  emptyText?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="shrink-0" data-testid={testId}>
      <span className="mb-[5px] block text-[12px] font-medium text-foreground">{label}</span>
      {value ? (
        <p className={
          multiline
            ? 'm-0 whitespace-pre-wrap break-words rounded-[10px] border border-border px-[12px] py-[10px] text-[13px] leading-[1.6] text-foreground'
            : 'm-0 break-words rounded-[10px] border border-border px-[12px] py-[10px] text-[13px] leading-[1.6] text-foreground'
        }>
          {value}
        </p>
      ) : (
        <p className="m-0 rounded-[10px] border border-border px-[12px] py-[10px] text-[13px] leading-[1.6] text-muted-foreground">
          {emptyText ?? t('projectSettings.notSet')}
        </p>
      )}
    </div>
  )
}
