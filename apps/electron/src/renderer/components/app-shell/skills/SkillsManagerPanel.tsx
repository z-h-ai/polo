import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useOptionalOrganizationContext } from '@/context/OrganizationContext'
import type { LoadedSkill } from '../../../../shared/types'
import { DiscoverSkillsList } from './DiscoverSkillsList'
import { LocalSkillsList } from './LocalSkillsList'
import { SkillActionButton } from './parts'
import { SkillDetailSheet } from './SkillDetailSheet'
import { SkillInstallSheet } from './SkillInstallSheet'
import {
  managedSkillFromLoaded,
  type DiscoverableSkill,
  type ManagedSkill,
  type SkillDetailMode,
  type SkillInstallPhase,
  type SkillSpaceKind,
} from './types'
import { ShareToOrgDialog } from './share/ShareToOrgDialog'

/** Which surface the panel's main area currently shows. */
type ManagerView =
  | { kind: 'local' }
  | { kind: 'discover' }
  | { kind: 'install'; entry: DiscoverableSkill; phase: SkillInstallPhase }
  | { kind: 'detail'; slug: string; mode: SkillDetailMode }
  | { kind: 'share'; phase: 'compose' | 'submitted' }

export interface SkillsManagerPanelProps {
  /** Skills from the existing data hooks (getSkills). */
  skills?: LoadedSkill[]
  /** Demo override for the local list (state-bit matrix samples). */
  managedSkills?: ManagedSkill[]
  /** Demo override for the discover list. */
  discoverItems?: DiscoverableSkill[]
  /** Space kind; derived from the organization context when omitted. */
  spaceKind?: SkillSpaceKind
  /** Display name of the active space. */
  spaceName?: string
  workspaceId?: string
  /** Available newer versions by slug (creator skill updates). */
  availableCreatorSkillVersions?: Record<string, string>
  /** Open the info page for a real skill (kept for AppShell wiring). */
  onSkillClick?: (skill: LoadedSkill) => void
  /** Delete a workspace-local skill copy (existing data hook). */
  onDeleteSkill?: (skillSlug: string) => void
  selectedSkillSlug?: string | null
  /** 回到对话 — returns focus to the assistant conversation. */
  onBackToChat?: () => void
  /** Open the circles surface (personal discover card). */
  onViewCircles?: () => void
  /** Force the install sheet into its failed phase (demo). */
  installFails?: boolean
  /** Initial tab; demos use it to screenshot the 获取 surface directly. */
  initialTab?: 'local' | 'discover'
  className?: string
}

/**
 * SkillsManagerPanel — the skill management surface replacing the legacy
 * SkillsListPanel: a 本机/获取 tab navigation with the local list, the
 * discover list (org shared library in enterprise spaces, circles in
 * personal spaces) and the install/detail/share sheets (R6 rules).
 */
export function SkillsManagerPanel({
  skills = [],
  managedSkills,
  discoverItems,
  spaceKind,
  spaceName,
  workspaceId,
  availableCreatorSkillVersions = {},
  onSkillClick,
  onDeleteSkill,
  selectedSkillSlug,
  onBackToChat,
  onViewCircles,
  installFails = false,
  initialTab = 'local',
  className,
}: SkillsManagerPanelProps) {
  const { t } = useTranslation()
  const organizationContext = useOptionalOrganizationContext()

  const resolvedSpaceKind = React.useMemo<SkillSpaceKind>(() => {
    if (spaceKind) return spaceKind
    const activeId = organizationContext?.activeOrganizationId
    const active = organizationContext?.organizationSummaries.find(
      (summary) => summary.id === activeId,
    )
    return active?.type === 'enterprise_workspace' ? 'enterprise' : 'personal'
  }, [spaceKind, organizationContext])

  const resolvedSpaceName = React.useMemo(() => {
    if (spaceName) return spaceName
    const activeId = organizationContext?.activeOrganizationId
    return organizationContext?.organizationSummaries.find(
      (summary) => summary.id === activeId,
    )?.name ?? t('skillsManager.space.personal')
  }, [spaceName, organizationContext, t])

  // Local enablement state: built-ins follow the client, distributed
  // copies start disabled (install never auto-enables) and flip only on
  // explicit user action.
  const [enabledOverrides, setEnabledOverrides] = React.useState<Record<string, boolean>>({})
  const localSkills = React.useMemo<ManagedSkill[]>(() => {
    const applyOverrides = (list: ManagedSkill[]) => list.map((item) => (
      enabledOverrides[item.slug] === undefined
        ? item
        : { ...item, enabled: enabledOverrides[item.slug] }
    ))
    if (managedSkills) return applyOverrides(managedSkills)
    return applyOverrides(skills.map((skill) => managedSkillFromLoaded(skill, {
      availableVersion: availableCreatorSkillVersions[skill.slug] || undefined,
    })))
  }, [managedSkills, skills, availableCreatorSkillVersions, enabledOverrides])

  const [orgDiscoverItems, setOrgDiscoverItems] = React.useState<DiscoverableSkill[] | null>(null)
  const [view, setView] = React.useState<ManagerView>(
    initialTab === 'discover' ? { kind: 'discover' } : { kind: 'local' },
  )
  const activeTab = view.kind === 'discover' || view.kind === 'install' ? 'discover' : 'local'

  // Enterprise shared library: load lazily when the 获取 tab opens.
  React.useEffect(() => {
    if (discoverItems || resolvedSpaceKind !== 'enterprise' || activeTab !== 'discover') return
    if (orgDiscoverItems) return
    let cancelled = false
    const activeOrgId = organizationContext?.activeOrganizationId
    if (!activeOrgId) {
      setOrgDiscoverItems([])
      return
    }
    void window.electronAPI.creatorArtifactList({
      organizationId: activeOrgId,
      type: 'skill',
    }).then((result) => {
      if (cancelled) return
      if (!result.success) {
        setOrgDiscoverItems([])
        return
      }
      setOrgDiscoverItems(
        result.artifacts
          .filter((artifact) => artifact.status === 'published')
          .map((artifact) => {
            const installed = localSkills.find(
              (skill) => skill.skill?.creatorInstallation?.artifactId === artifact.id,
            )
            return {
              slug: artifact.slug,
              name: artifact.name ?? artifact.slug,
              description: artifact.summary ?? '',
              provider: resolvedSpaceName,
              version: artifact.latestPublishedVersion ?? '1.0.0',
              glyph: artifact.displayIcon?.kind === 'emoji' ? artifact.displayIcon.value : '✧',
              installed: installed
                ? {
                  version: installed.installedVersion ?? '1.0.0',
                  enabled: installed.enabled,
                  restricted: installed.restricted,
                  updateVersion: installed.availableVersion,
                }
                : undefined,
            }
          }),
      )
    }).catch(() => {
      if (!cancelled) setOrgDiscoverItems([])
    })
    return () => {
      cancelled = true
    }
  }, [
    discoverItems,
    resolvedSpaceKind,
    activeTab,
    orgDiscoverItems,
    organizationContext,
    localSkills,
    resolvedSpaceName,
  ])

  const effectiveDiscoverItems = discoverItems
    ?? orgDiscoverItems
    ?? []

  const handleToggleEnabled = (skill: ManagedSkill, enabled: boolean) => {
    setEnabledOverrides((current) => ({ ...current, [skill.slug]: enabled }))
    toast(
      enabled
        ? t('skillsManager.toast.enabled', { name: skill.name })
        : t('skillsManager.toast.disabled', { name: skill.name }),
      { description: t('skillsManager.toast.toggleScope') },
    )
  }

  const handleManageManaged = (skill: ManagedSkill) => {
    if (skill.skill && onSkillClick) {
      onSkillClick(skill.skill)
      return
    }
    setView({ kind: 'detail', slug: skill.slug, mode: 'manage' })
  }

  const handleManageDiscover = (entry: DiscoverableSkill) => {
    const local = localSkills.find((skill) => skill.slug === entry.slug)
    if (local?.skill && onSkillClick) {
      onSkillClick(local.skill)
      return
    }
    setView({ kind: 'detail', slug: entry.slug, mode: 'manage' })
  }

  const handleInstall = (entry: DiscoverableSkill) => {
    if (installFails) {
      setView({ kind: 'install', entry, phase: 'failed' })
      return
    }
    setView({ kind: 'install', entry, phase: 'installing' })
    window.setTimeout(() => {
      setView({ kind: 'local' })
      toast(t('skillsManager.toast.installed', { name: entry.name }), {
        description: t('skillsManager.install.footnote'),
      })
    }, 600)
  }

  const handleUninstall = (skill: ManagedSkill) => {
    const realSkill = skill.skill
    if (realSkill && realSkill.source === 'workspace' && onDeleteSkill) {
      onDeleteSkill(skill.slug)
      return
    }
    toast(t('skillsManager.toast.uninstalled', { name: skill.name }))
    setView({ kind: 'local' })
  }

  const headerTitle = view.kind === 'local'
    ? t('skillsManager.local.title')
    : view.kind === 'discover'
      ? t(resolvedSpaceKind === 'enterprise'
        ? 'skillsManager.discover.title.ent'
        : 'skillsManager.discover.title.circle')
      : view.kind === 'install'
        ? view.entry.name
        : view.kind === 'share'
          ? t('skillsManager.share.title', { org: resolvedSpaceName })
          : localSkills.find((skill) => skill.slug === view.slug)?.name ?? ''

  const headerSubtitle = view.kind === 'local'
    ? t('skillsManager.local.subtitle', { space: resolvedSpaceName })
    : view.kind === 'discover'
      ? t(resolvedSpaceKind === 'enterprise'
        ? 'skillsManager.discover.desc.ent'
        : 'skillsManager.discover.desc.circle')
      : view.kind === 'install'
        ? view.entry.provider
        : view.kind === 'detail'
          ? (localSkills.find((skill) => skill.slug === view.slug)?.provider ?? resolvedSpaceName)
          : t('skillsManager.share.desc')

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-hifi-background', className)}
      data-list-role="skills"
      data-testid="skills-manager-panel"
    >
      {/* Tab navigation: 本机已安装 | 企业共享 / 从圈子获取 */}
      <nav
        aria-label={t('skillsManager.nav.label')}
        className="flex shrink-0 items-center gap-1 border-b border-hifi-border px-2 py-1.5"
      >
        {(['local', 'discover'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setView(tab === 'local' ? { kind: 'local' } : { kind: 'discover' })}
            aria-current={activeTab === tab}
            className={cn(
              'h-7 rounded-hifi-sm px-2.5 text-hifi-sm font-medium transition-colors',
              activeTab === tab
                ? 'bg-hifi-accent-soft text-hifi-accent'
                : 'text-hifi-fg-60 hover:bg-hifi-fg-5',
            )}
          >
            {t(tab === 'local'
              ? 'skillsManager.nav.local'
              : resolvedSpaceKind === 'enterprise'
                ? 'skillsManager.nav.discover.ent'
                : 'skillsManager.nav.discover.circle')}
          </button>
        ))}
        <p className="ml-auto hidden max-w-[46%] truncate text-hifi-xs text-hifi-fg-50 xl:block">
          {t('skillsManager.nav.note')}
        </p>
      </nav>

      {/* Main header */}
      <header className="flex shrink-0 items-start justify-between gap-2 px-3 pb-2 pt-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-hifi-md font-semibold text-hifi-foreground">
            {headerTitle}
          </h1>
          <p className="mt-0.5 truncate text-hifi-xs text-hifi-fg-50">{headerSubtitle}</p>
        </div>
        {onBackToChat && (
          <SkillActionButton onClick={onBackToChat}>
            {t('skillsManager.backToChat')}
          </SkillActionButton>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
        {view.kind === 'local' && (
          <LocalSkillsList
            skills={localSkills}
            spaceKind={resolvedSpaceKind}
            spaceName={resolvedSpaceName}
            workspaceId={workspaceId}
            selectedSlug={selectedSkillSlug ?? undefined}
            onToggleEnabled={handleToggleEnabled}
            onManage={handleManageManaged}
            onReauthorize={(skill) => {
              toast(t('skillsManager.toast.reauthorize', { name: skill.name }))
            }}
            onViewRestrictedReason={(skill) => {
              toast(
                t('skillsManager.restricted.reason.title'),
                {
                  description: skill.restrictedReason
                    ? t(`skillsManager.restricted.reason.${skill.restrictedReason}`)
                    : t('skillsManager.restricted.reason.default'),
                },
              )
            }}
            onUninstall={(skill) => setView({ kind: 'detail', slug: skill.slug, mode: skill.restricted ? 'confirm-uninstall-restricted' : 'confirm-uninstall' })}
            onGetSkills={() => setView({ kind: 'discover' })}
          />
        )}

        {view.kind === 'discover' && (
          <DiscoverSkillsList
            items={effectiveDiscoverItems}
            spaceKind={resolvedSpaceKind}
            spaceName={resolvedSpaceName}
            onViewInstall={(entry) => setView({ kind: 'install', entry, phase: 'review' })}
            onManage={handleManageDiscover}
            onShareToOrg={resolvedSpaceKind === 'enterprise'
              ? () => setView({ kind: 'share', phase: 'compose' })
              : undefined}
            onViewCircles={onViewCircles}
          />
        )}

        {view.kind === 'install' && (
          <SkillInstallSheet
            name={view.entry.name}
            description={view.entry.description}
            provider={view.entry.provider}
            version={view.entry.version}
            spaceKind={resolvedSpaceKind}
            spaceName={resolvedSpaceName}
            phase={view.phase}
            onInstall={() => handleInstall(view.entry)}
            onRetry={() => handleInstall(view.entry)}
            onBack={() => setView({ kind: 'discover' })}
          />
        )}

        {view.kind === 'detail' && (() => {
          const skill = localSkills.find((item) => item.slug === view.slug)
            ?? managedSkills?.find((item) => item.slug === view.slug)
          if (!skill) return null
          return (
            <SkillDetailSheet
              skill={skill}
              spaceName={resolvedSpaceName}
              mode={view.mode}
              onToggleEnabled={handleToggleEnabled}
              onUpdate={(target) => {
                toast(t('skillsManager.toast.updating', { name: target.name }))
                setView({ kind: 'detail', slug: target.slug, mode: 'manage' })
              }}
              onReauthorize={() => {
                toast(t('skillsManager.toast.reauthorize', { name: skill.name }))
              }}
              onViewRestrictedReason={() => {
                toast(t('skillsManager.restricted.reason.title'), {
                  description: skill.restrictedReason
                    ? t(`skillsManager.restricted.reason.${skill.restrictedReason}`)
                    : t('skillsManager.restricted.reason.default'),
                })
              }}
              onRequestUninstall={(target) => setView({
                kind: 'detail',
                slug: target.slug,
                mode: target.restricted
                  ? 'confirm-uninstall-restricted'
                  : 'confirm-uninstall',
              })}
              onConfirmUninstall={handleUninstall}
              onCancelUninstall={() => setView({ kind: 'detail', slug: skill.slug, mode: 'manage' })}
              onBack={() => setView({ kind: 'local' })}
            />
          )
        })()}

        {view.kind === 'share' && (
          <ShareToOrgDialog
            orgName={resolvedSpaceName}
            skillName={t('skillsManager.share.defaultSkillName')}
            phase={view.phase}
            onSubmit={() => setView({ kind: 'share', phase: 'submitted' })}
            onCancel={() => setView({ kind: 'discover' })}
            onBack={() => setView({ kind: 'discover' })}
          />
        )}
      </div>
    </div>
  )
}
