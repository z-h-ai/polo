import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CopySlash, ShieldAlert, ShieldQuestion, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { isCanonicalManagedSkill } from '@polo-ai/shared/skills/managed'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { Switch, SwitchThumb, switchThumbClassName } from '@/components/ui/switch'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { skillSelection } from '@/hooks/useEntitySelection'
import { useManagedSkills } from '@/hooks/useManagedSkills'
import { managedEnablementErrorKey, managedEnablementErrorCode } from '@/lib/managed-skill-enablement-copy'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { SkillMenu } from './SkillMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { getFileManagerName } from '@/lib/platform'
import { creatorSkillHasStaleSafetyStatus } from '@/lib/creator-skill-safety-display'
import type { LoadedSkill } from '../../../shared/types'

export interface SkillsListPanelProps {
  skills: LoadedSkill[]
  onDeleteSkill: (skillSlug: string) => void
  onSkillClick: (skill: LoadedSkill) => void
  selectedSkillSlug?: string | null
  workspaceId?: string
  workspaceRootPath?: string
  availableCreatorSkillVersions?: Record<string, string>
  className?: string
}

export function SkillsListPanel({
  skills,
  onDeleteSkill,
  onSkillClick,
  selectedSkillSlug,
  workspaceId,
  workspaceRootPath,
  availableCreatorSkillVersions = {},
  className,
}: SkillsListPanelProps) {
  const { t } = useTranslation()
  const activeWorkspace = useActiveWorkspace()
  const canRevealLocally = !activeWorkspace?.remoteServer
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1
  // Enablement is a personal-space, local-workspace concept (POO-106 S1, K3).
  const productSpace = useOptionalProductSpaceContext()
  const isPersonalLocalScope = productSpace?.activeProductSpace.kind === 'personal' && !activeWorkspace?.remoteServer
  const { statusBySlug, inventoryRows, setSkillEnabled } = useManagedSkills(workspaceId)

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  // The filtered `skills` prop also feeds the composer (SM-09), so the
  // management list renders the union with the unfiltered inventory: a
  // disabled row stays listed and its switch can re-enable it (B1).
  const listedSkills = React.useMemo(() => {
    const listed = new Set(skills.map(skill => skill.slug))
    const inventoryOnly = inventoryRows.filter(skill => !listed.has(skill.slug))
    return inventoryOnly.length > 0 ? [...skills, ...inventoryOnly] : skills
  }, [skills, inventoryRows])

  const handleToggle = async (skill: LoadedSkill, enabled: boolean) => {
    const status = statusBySlug[skill.slug]
    if (!status) return
    try {
      await setSkillEnabled(status, enabled)
    } catch (err) {
      const errorCode = managedEnablementErrorCode(err)
      console.error('[skills] Managed skill enablement write failed:', errorCode)
      toast.error(t('skillsList.enableFailed'), { description: t(managedEnablementErrorKey(errorCode)) })
    }
  }

  return (
    <>
    <EntityPanel<LoadedSkill>
      items={listedSkills}
      getId={(s) => s.slug}
      selection={skillSelection}
      selectedId={selectedSkillSlug}
      onItemClick={onSkillClick}
      className={className}
      containerProps={{ 'data-list-role': 'skills' }}
      // SM-18b/18g + K8: bundled, managed and shadowedBuiltin rows never
      // enter batch selection — no toggle affordance, no checkbox, no count.
      isSelectable={(skill) => {
        const status = statusBySlug[skill.slug]
        return Boolean(status?.toggleable)
      }}
      emptyState={
        <EntityListEmptyScreen
          icon={<Zap />}
          title={t('skillsList.noSkillsConfigured')}
          description={t('skillsList.emptyDescription')}
          docKey="skills"
        >
          {workspaceRootPath && (
            <EditPopover
              align="center"
              trigger={
                <button className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors">
                  {t('skillsList.addSkill')}
                </button>
              }
              {...getEditConfig('add-skill', workspaceRootPath)}
            />
          )}
        </EntityListEmptyScreen>
      }
      mapItem={(skill) => {
        const status = statusBySlug[skill.slug]
        const isManaged = isCanonicalManagedSkill(skill)
        const shadowedBuiltin = status?.shadowedBuiltin === true
        const isUserTier = skill.source !== 'bundled' && !isManaged && !shadowedBuiltin
        const toggleReady = isPersonalLocalScope && status?.toggleable === true
        // Outside the personal/local scope the switch renders disabled with an
        // explanation (K3) instead of disappearing silently.
        const scopeBlocked = isUserTier && !isPersonalLocalScope
        const enabled = status?.enabled !== false
        const toggleLabel = enabled
          ? t('skillsList.disableSkill')
          : t('skillsList.enableSkill')
        return ({
          icon: <SkillAvatar skill={skill} size="sm" workspaceId={workspaceId} />,
          title: skill.metadata.name,
          badges: (
            <span className="flex items-center gap-1.5 min-w-0">
              {skill.source === 'project' && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-foreground/5 text-muted-foreground">
                  {t('skillsList.projectBadge')}
                </span>
              )}
              {skill.source === 'bundled' && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-foreground/5 text-muted-foreground">
                  {t('skillsList.bundledBadge')}
                </span>
              )}
              {status?.shadowedBuiltin && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  title={skill.source === 'global'
                    ? t('skillsList.shadowedBuiltinGlobalHint')
                    : t('skillsList.shadowedBuiltinHint')}
                >
                  <CopySlash className="size-3" />
                  {t('skillsList.shadowedBuiltinBadge')}
                </span>
              )}
              {skill.creatorInstallation?.lastKnownStatus === 'revoked' ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
                  <ShieldAlert className="size-3" />
                  {t('creatorSkills.safety.revoked')}
                </span>
              ) : null}
              {creatorSkillHasStaleSafetyStatus(skill) ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700">
                  <ShieldQuestion className="size-3" />
                  {t('creatorSkills.safety.stale')}
                </span>
              ) : null}
              {availableCreatorSkillVersions[skill.slug] ? (
                <span className="inline-flex shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                  {t('creatorSkills.update.available', {
                    version: availableCreatorSkillVersions[skill.slug],
                  })}
                </span>
              ) : null}
              <span className="truncate">{skill.metadata.description}</span>
            </span>
          ),
          // The toggle lives inside the row <button>, so it renders as a span
          // via asChild — a nested button would be invalid DOM (and browsers
          // would reparent it). Radix still owns role/aria/state; the span
          // needs explicit keyboard activation a native button gets for free.
          trailing: toggleReady ? (
            <Switch
              asChild
              checked={enabled}
              onCheckedChange={(checked) => { void handleToggle(skill, checked) }}
            >
              <span
                role="switch"
                tabIndex={0}
                aria-label={`${toggleLabel}: ${skill.metadata.name}`}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    void handleToggle(skill, !enabled)
                  }
                }}
              >
                <SwitchThumb />
              </span>
            </Switch>
          ) : scopeBlocked ? (
            <span
              role="switch"
              aria-checked={enabled}
              aria-disabled="true"
              aria-label={`${toggleLabel}: ${skill.metadata.name}`}
              title={t('skillsList.enablementScopeHint')}
              className="inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent bg-foreground/15 opacity-50 shadow-xs dark:bg-foreground/12"
            >
              <span className={cn(switchThumbClassName, 'translate-x-[calc(100%-2px)]')} />
            </span>
          ) : undefined,
          menu: (
            <SkillMenu
              skillSlug={skill.slug}
              skillName={skill.metadata.name}
              onOpenInNewWindow={() => window.electronAPI.openUrl(`poloai://skills/skill/${skill.slug}?window=focused`)}
              onShowInFinder={async () => {
                if (!canRevealLocally) return
                try {
                  await window.electronAPI.showInFolder(skill.path)
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err)
                  toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
                    description: message,
                  })
                }
              }}
              canShowInFinder={canRevealLocally}
              onDelete={skill.source === 'workspace' ? () => onDeleteSkill(skill.slug) : undefined}
              canDelete={skill.source === 'workspace'}
              deleteLabel={
                skill.source === 'workspace' ? t('skillsList.deleteSkill')
                  : skill.source === 'bundled' ? t('skillInfo.builtInNotRemovable')
                    : t('skillsList.managedByProject')
              }
              onSendToWorkspace={hasOtherWorkspaces && skill.source === 'workspace' ? () => {
                setSendResourceSlug(skill.slug)
                setSendResourceLabel(skill.metadata.name)
                setSendDialogOpen(true)
              } : undefined}
            />
          ),
        })
      }}
    />

    {/* Send to Workspace dialog */}
    {sendResourceSlug && (
      <SendResourceToWorkspaceDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        resourceType="skill"
        resourceIds={[sendResourceSlug]}
        resourceLabel={sendResourceLabel}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />
    )}
    </>
  )
}
