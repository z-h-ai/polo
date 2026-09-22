import { useMemo } from 'react'
import type { ReactNode } from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { LocalAppRuntimeStatus } from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/hifi'
import { cn } from '@/lib/utils'
import {
  OrganizationAppCard,
  type CatalogPrimaryAction,
} from './OrganizationAppCard'

/**
 * 全部应用目录（P-M03-ALL-APPS*）。
 *
 * 圈子来源按「作品 ID」去重：同一作品只显示一张卡，多个圈子来源并列
 * 展示（D-PC-09）；全部来源失效时卡片标为 blocked，走 inspector 查看原因。
 */

// 跨 WS 契约类型统一定义在 circles/types（ws-circles-account 所有）；
// 这里保留旧名别名，供 HomePage/测试继续引用。
import type { CircleSourcedApp, CircleWorkSource as CircleAppSource } from './circles/types'
export type { CircleSourcedApp }
export type { CircleWorkSource as CircleAppSource } from './circles/types'

export interface DedupedCircleApp {
  appId: string
  name: string
  iconUrl?: string
  sources: CircleAppSource[]
  /** 没有任何有效来源（全部撤下）。 */
  blocked: boolean
}

/**
 * Merge circle-sourced entries by appId (D-PC-09):
 * - same-appId entries collapse into one card with all sources listed
 * - a source turning invalid alone never hides the app while another is valid
 * - once every source is invalid the card is blocked (still listed, opens inspector)
 */
export function dedupeCircleSourcedApps(
  apps: readonly CircleSourcedApp[],
): DedupedCircleApp[] {
  const merged = new Map<string, {
    order: number
    appId: string
    name: string
    iconUrl?: string
    sources: Map<string, CircleAppSource>
  }>()
  let order = 0
  for (const app of apps) {
    if (!app || typeof app.appId !== 'string' || app.appId.length === 0) continue
    const sources = new Map<string, CircleAppSource>()
    for (const source of app.sources ?? []) {
      if (!source || typeof source.circleId !== 'string') continue
      // Same circle listed twice: the later entry carries the newer validity.
      sources.set(source.circleId, source)
    }
    const existing = merged.get(app.appId)
    if (!existing) {
      merged.set(app.appId, {
        order: order++,
        appId: app.appId,
        name: app.name,
        iconUrl: app.iconUrl,
        sources,
      })
      continue
    }
    for (const [circleId, source] of sources) {
      existing.sources.set(circleId, source)
    }
    existing.iconUrl = existing.iconUrl ?? app.iconUrl
  }
  return [...merged.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, sources, ...rest }) => ({
      ...rest,
      sources: [...sources.values()],
      blocked: sources.size > 0 && [...sources.values()]
        .every(source => !source.valid),
    }))
}

export interface OrganizationDirectoryEntry {
  /** Catalog scope key — used as pinned/hidden id and inspector target. */
  id: string
  app: CatalogApp
  status?: LocalAppRuntimeStatus
  statusLoading?: boolean
  statusUnavailable?: boolean
  compatible: boolean
  offline: boolean
  pinned: boolean
}

export interface CircleDirectoryEntry extends DedupedCircleApp {
  pinned: boolean
}

/** Toggle target for pinned/hidden preferences. */
export interface DirectoryToggleTarget {
  id: string
  name: string
  iconUrl?: string
  kind: 'organization' | 'circle'
}

interface AllAppsPageProps {
  onBack: () => void
  loading?: boolean
  organizationEntries: OrganizationDirectoryEntry[]
  circleEntries: CircleDirectoryEntry[]
  hiddenCount: number
  onViewHidden: () => void
  onTogglePinned: (target: DirectoryToggleTarget, pinned: boolean) => void
  onHide: (target: DirectoryToggleTarget) => void
  onInspectOrganization: (entry: OrganizationDirectoryEntry) => void
  onInspectCircle: (entry: CircleDirectoryEntry) => void
  onOpenCircleApp?: (entry: CircleDirectoryEntry) => void
  onOrganizationPrimaryAction: (
    app: CatalogApp,
    action: CatalogPrimaryAction,
  ) => void
  onOrganizationStop: (app: CatalogApp) => void
  onOrganizationUninstall: (app: CatalogApp) => void
  onOrganizationViewLogs: (app: CatalogApp) => void
  /** Rendered when both lists are empty and not loading. */
  emptyState?: ReactNode
}

function CircleSourcePill({ source }: { source: CircleAppSource }) {
  const { t } = useTranslation()
  if (!source.valid) {
    return (
      <StatusPill tone="destructive">
        {source.circleName}
        {' · '}
        {t('homeApps.inspector.sourceInvalid')}
      </StatusPill>
    )
  }
  return <StatusPill tone="neutral">{source.circleName}</StatusPill>
}

function CircleAppCard({
  entry,
  onOpen,
  onInspect,
  onTogglePinned,
  onHide,
}: {
  entry: CircleDirectoryEntry
  onOpen?: (entry: CircleDirectoryEntry) => void
  onInspect: (entry: CircleDirectoryEntry) => void
  onTogglePinned: (target: DirectoryToggleTarget, pinned: boolean) => void
  onHide: (target: DirectoryToggleTarget) => void
}) {
  const { t } = useTranslation()
  const toggleTarget: DirectoryToggleTarget = {
    id: entry.appId,
    name: entry.name,
    iconUrl: entry.iconUrl,
    kind: 'circle',
  }
  return (
    <article
      data-testid={`directory-circle-${entry.appId}`}
      className="flex flex-col gap-3 rounded-xl border border-foreground/10 bg-background p-4"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-foreground/10 bg-foreground/5">
          {entry.iconUrl
            ? <img src={entry.iconUrl} alt="" className="h-full w-full object-cover" />
            : (
              <span className="text-base font-semibold text-foreground/70">
                {entry.name.trim().slice(0, 1).toUpperCase() || '?'}
              </span>
            )}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{entry.name}</h3>
          {entry.blocked && (
            <p className="mt-1">
              <StatusPill tone="destructive">
                {t('homeApps.allApps.blocked')}
              </StatusPill>
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {entry.sources.map(source => (
          <CircleSourcePill key={source.circleId} source={source} />
        ))}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        {onOpen && (
          <Button
            type="button"
            size="sm"
            disabled={entry.blocked}
            onClick={() => onOpen(entry)}
          >
            {t('homeApps.inspector.open')}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onInspect(entry)}
        >
          {t('homeApps.allApps.viewReason')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onTogglePinned(toggleTarget, entry.pinned)}
        >
          {entry.pinned
            ? t('homeApps.allApps.removeHome')
            : t('homeApps.allApps.addToHome')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('homeApps.allApps.hide')}
          onClick={() => onHide(toggleTarget)}
        >
          <Icons.EyeOff className="size-4" strokeWidth={1.5} />
        </Button>
      </div>
    </article>
  )
}

function OrganizationEntryCard({
  entry,
  onInspect,
  onTogglePinned,
  onHide,
  onPrimaryAction,
  onStop,
  onUninstall,
  onViewLogs,
}: {
  entry: OrganizationDirectoryEntry
  onInspect: (entry: OrganizationDirectoryEntry) => void
  onTogglePinned: (target: DirectoryToggleTarget, pinned: boolean) => void
  onHide: (target: DirectoryToggleTarget) => void
  onPrimaryAction: (
    app: CatalogApp,
    action: CatalogPrimaryAction,
  ) => void
  onStop: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
  onViewLogs: (app: CatalogApp) => void
}) {
  const { t } = useTranslation()
  const { app } = entry
  const toggleTarget: DirectoryToggleTarget = {
    id: entry.id,
    name: app.name,
    iconUrl: app.iconUrl,
    kind: 'organization',
  }
  return (
    <div
      data-testid={`directory-organization-${app.id}`}
      className="flex flex-col gap-2"
    >
      <OrganizationAppCard
        app={app}
        status={entry.status}
        statusLoading={entry.statusLoading}
        statusUnavailable={entry.statusUnavailable}
        compatible={entry.compatible}
        offline={entry.offline}
        onPrimaryAction={(target, action) => onPrimaryAction(target, action)}
        onStop={onStop}
        onUninstall={onUninstall}
        onViewLogs={onViewLogs}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onInspect(entry)}
        >
          {t('homeApps.allApps.viewReason')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onTogglePinned(toggleTarget, entry.pinned)}
        >
          {entry.pinned
            ? t('homeApps.allApps.removeHome')
            : t('homeApps.allApps.addToHome')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('homeApps.allApps.hide')}
          onClick={() => onHide(toggleTarget)}
        >
          <Icons.EyeOff className="size-4" strokeWidth={1.5} />
        </Button>
      </div>
    </div>
  )
}

export function AllAppsPage({
  onBack,
  loading = false,
  organizationEntries,
  circleEntries,
  hiddenCount,
  onViewHidden,
  onTogglePinned,
  onHide,
  onInspectOrganization,
  onInspectCircle,
  onOpenCircleApp,
  onOrganizationPrimaryAction,
  onOrganizationStop,
  onOrganizationUninstall,
  onOrganizationViewLogs,
  emptyState,
}: AllAppsPageProps) {
  const { t } = useTranslation()
  const isEmpty = !loading
    && organizationEntries.length === 0
    && circleEntries.length === 0
  const showHiddenLink = hiddenCount > 0
  const body = useMemo(() => {
    if (loading) {
      return (
        <div className="flex min-h-40 items-center justify-center rounded-xl border border-foreground/10">
          <Icons.LoaderCircle
            className="size-5 animate-spin text-muted-foreground"
            strokeWidth={1.5}
          />
        </div>
      )
    }
    if (isEmpty) {
      return emptyState ?? (
        <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-foreground/15 px-6 text-center text-sm text-muted-foreground">
          {t('homeApps.allApps.emptyTitle')}
        </div>
      )
    }
    return (
      <div className="space-y-8">
        {organizationEntries.length > 0 && (
          <section aria-labelledby="all-apps-organization-heading">
            <h2
              id="all-apps-organization-heading"
              className="mb-3 text-base font-semibold"
            >
              {t('homeApps.allApps.organizationSection')}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {organizationEntries.map(entry => (
                <OrganizationEntryCard
                  key={entry.id}
                  entry={entry}
                  onInspect={onInspectOrganization}
                  onTogglePinned={onTogglePinned}
                  onHide={onHide}
                  onPrimaryAction={onOrganizationPrimaryAction}
                  onStop={onOrganizationStop}
                  onUninstall={onOrganizationUninstall}
                  onViewLogs={onOrganizationViewLogs}
                />
              ))}
            </div>
          </section>
        )}
        {circleEntries.length > 0 && (
          <section aria-labelledby="all-apps-circle-heading">
            <h2
              id="all-apps-circle-heading"
              className="mb-3 text-base font-semibold"
            >
              {t('homeApps.allApps.circleSection')}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {circleEntries.map(entry => (
                <CircleAppCard
                  key={entry.appId}
                  entry={entry}
                  onOpen={onOpenCircleApp}
                  onInspect={onInspectCircle}
                  onTogglePinned={onTogglePinned}
                  onHide={onHide}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    )
  }, [
    circleEntries,
    emptyState,
    isEmpty,
    loading,
    onHide,
    onInspectCircle,
    onInspectOrganization,
    onOpenCircleApp,
    onOrganizationPrimaryAction,
    onOrganizationStop,
    onOrganizationUninstall,
    onOrganizationViewLogs,
    onTogglePinned,
    organizationEntries,
    t,
  ])

  return (
    <div data-testid="all-apps-page" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">
            {t('homeApps.allApps.title')}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('homeApps.allApps.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {showHiddenLink && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onViewHidden}
            >
              <Icons.EyeOff className="size-4" strokeWidth={1.5} />
              {t('homeApps.allApps.hiddenCount', { count: hiddenCount })}
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={onBack}>
            <Icons.ArrowLeft className="size-4" strokeWidth={1.5} />
            {t('homeApps.allApps.back')}
          </Button>
        </div>
      </div>
      <div className={cn(loading && 'opacity-70')}>{body}</div>
    </div>
  )
}
