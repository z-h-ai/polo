import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Icons from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { AppCatalogCacheEntry, CatalogApp } from '@polo-ai/shared/admin'
import type {
  HomeRecentAppKind,
  HomeRecentAppPreference,
} from '@polo-ai/shared/config/home-recent'
import {
  createLocalAppScopeKey,
  type LocalAppRuntimeStatus,
} from '@polo-ai/shared/protocol'
import { AppIcon } from './AppIcon'
import { useAppRuntimeTasks } from './AppRuntimeTasksContext'
import {
  OrganizationAppCard,
  statusText,
  type CatalogPrimaryAction,
} from './OrganizationAppCard'
import {
  AllAppsPage,
  dedupeCircleSourcedApps,
  type CircleDirectoryEntry,
  type CircleSourcedApp,
  type OrganizationDirectoryEntry,
} from './AllAppsPage'
import { AppInspector, type AppInspectorTarget } from './AppInspector'
import { ManageHomeApps, type ManageHomeAppItem } from './ManageHomeApps'
import { HiddenApps, type HiddenAppItem } from './HiddenApps'
import {
  DirectoryLoadFailedState,
  EmptyDirectoryState,
  OfflineDirectoryState,
  ZeroFrequentState,
} from './HomeStates'
import { useHomeView } from './HomeViewState'
import {
  HOME_FREQUENT_APP_LIMIT,
  loadHiddenHomeApps,
  loadHomePinnedApps,
  saveHiddenHomeApps,
  saveHomePinnedApps,
  type HiddenHomeAppKind,
  type HiddenHomeAppRef,
  type PinnedHomeAppRef,
} from './home-surface-preferences'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAppCatalog } from '@/hooks/useAppCatalog'
import { useTabShell } from '@/context/TabShellContext'
import { useHomeSurfaceSlots } from '@/context/HomeSurfaceSlotsContext'
import {
  BUILTIN_APP_IDS,
  POLO_APP_DEFINITION,
  type AppDefinition,
} from '../../../shared/tab-browser-types'
import {
  catalogStateMessage,
  getHomeAppErrorCode,
  homeAppOperationErrorText,
} from '@/lib/home-app-errors'
import {
  createHomeRecentContextKey,
  loadHomeRecentApps,
  saveHomeRecentApps,
} from '@/lib/home-recent-apps'

interface HomePageProps {
  onAddApp: () => void
  /** 已登录账号的展示名（原型 P-M03 home-hero 问候语）。 */
  userName?: string
}

const MAX_RECENT_APPS = 6
export const ORGANIZATION_APP_PAGE_SIZE = 60

/** 个人隐藏/常用偏好里可被固定或隐藏的目录条目。 */
interface DirectoryPreferenceTarget {
  id: string
  name: string
  iconUrl?: string
  kind: PinnedHomeAppRef['kind']
}

/** 可被隐藏的目录条目（组织/圈子；外部快捷方式走移除流程）。 */
interface HidePreferenceTarget {
  id: string
  name: string
  iconUrl?: string
  kind: HiddenHomeAppKind
}

export function selectOrganizationAppsForDisplay(
  catalog: AppCatalogCacheEntry | null,
  statuses: Readonly<Record<string, LocalAppRuntimeStatus>>,
  statusErrorScopeKeys: Readonly<Record<string, true>> = {},
): CatalogApp[] {
  if (!catalog) return []
  const withdrawnWithLocalData = (catalog.withdrawnApps ?? []).filter(app => {
    if (app.deliveryMode !== 'local_bundle') return false
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: app.id,
    })
    const status = statuses[scopeKey]
    return Boolean(
      (status && status.status !== 'not_installed')
      || statusErrorScopeKeys[scopeKey],
    )
  })
  return [...catalog.apps, ...withdrawnWithLocalData]
    .sort((left, right) => left.sortOrder - right.sortOrder)
}

export function formatBytes(t: TFunction, sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return t('homeApps.install.unknownSize')
  }
  const unitKeys = [
    'homeApps.install.sizeUnit.bytes',
    'homeApps.install.sizeUnit.kilobytes',
    'homeApps.install.sizeUnit.megabytes',
    'homeApps.install.sizeUnit.gigabytes',
  ] as const
  let size = sizeBytes
  let unit = 0
  while (size >= 1024 && unit < unitKeys.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${
    size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)
  } ${t(unitKeys[unit]!)}`
}

function formatCatalogSyncedAt(
  language: string,
  syncedAt: number | undefined,
): string | null {
  if (!syncedAt || !Number.isFinite(syncedAt) || syncedAt <= 0) return null
  const date = new Date(syncedAt)
  try {
    return new Intl.DateTimeFormat(language, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    return date.toLocaleTimeString()
  }
}

function catalogTabDefinition(
  scopeKey: string,
  app: CatalogApp,
  url: string,
): AppDefinition {
  return {
    id: `organization:${scopeKey}`,
    name: app.name,
    url,
    iconUrl: app.iconUrl,
    type: 'webapp',
    createdAt: 0,
    order: app.sortOrder,
  }
}

function catalogRecentId(scopeKey: string): string {
  return scopeKey
}

/**
 * 首页问候区（原型 P-M03 home-hero）：时间段问候 + 展示名，副行「继续
 * {空间} 的工作」；个人空间的右侧挂「我的圈子」入口（ws-circles-account）。
 */
function HomeHero({
  userName,
  spaceName,
  circlesSlot,
}: {
  userName?: string
  spaceName: string
  circlesSlot?: () => ReactNode
}) {
  const { t } = useTranslation()
  const hour = new Date().getHours()
  const greeting = hour < 12
    ? t('home.hero.morning')
    : hour < 18
      ? t('home.hero.afternoon')
      : t('home.hero.evening')
  return (
    <section className="flex items-end justify-between gap-7" data-testid="home-hero">
      <div className="min-w-0">
        <h1 className="m-0 text-[clamp(30px,3vw,38px)] font-bold leading-[1.08] tracking-[-0.055em] text-foreground">
          {t('home.hero.greeting', { greeting, name: userName || t('home.hero.personalSpace') })}
        </h1>
        <p className="m-0 mt-3 text-[15px] leading-[1.65] text-muted-foreground">
          {t('home.hero.continueWork', { space: spaceName })}
        </p>
      </div>
      {circlesSlot && <div className="shrink-0">{circlesSlot()}</div>}
    </section>
  )
}

/**
 * 助手大卡（原型 P-M03 常用 Apps 栅格首卡，assistant-card）：企业/个人空间
 * 都固定展示、不占常用名额（D-PC-07）。技能管理在助手侧栏内进行。
 */
function HomeAssistantCard({ onOpenAssistant }: { onOpenAssistant: () => void }) {
  const { t } = useTranslation()
  return (
    <article
      className="relative flex min-h-[176px] flex-col rounded-xl border border-foreground/10 bg-[var(--background-elevated)] p-4 shadow-xs transition-shadow hover:shadow-minimal"
      data-testid="home-assistant-entry-card"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
          <Icons.Sparkles className="size-5" strokeWidth={1.5} />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">
            {POLO_APP_DEFINITION.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t('homeApps.assistant.cardMeta')}
          </p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 min-h-9 text-xs leading-[18px] text-foreground/65">
        {t('homeApps.assistant.cardDescription')}
      </p>
      <div className="mt-auto flex items-center justify-end gap-2 pt-3">
        <Button type="button" size="sm" variant="secondary" onClick={onOpenAssistant}>
          {t('homeApps.assistant.manageSkills')}
        </Button>
        <Button type="button" size="sm" onClick={onOpenAssistant}>
          {t('homeApps.assistant.openAction')}
        </Button>
      </div>
    </article>
  )
}

/** 系统工具（原型 P-M03 utility-grid）：文件 / 任务与结果两张工具卡。 */
function HomeUtilitySection({ onOpenFiles }: { onOpenFiles: () => void }) {
  const { t } = useTranslation()
  const runtime = useAppRuntimeTasks()
  const cards = [
    {
      id: 'files',
      icon: <Icons.FileText className="size-5" strokeWidth={1.5} />,
      title: t('home.tools.files'),
      description: t('home.tools.filesDescription'),
      onClick: onOpenFiles,
    },
    {
      id: 'tasks',
      icon: <Icons.ListChecks className="size-5" strokeWidth={1.5} />,
      title: t('home.tools.tasks'),
      description: t('home.tools.tasksDescription'),
      onClick: runtime.toggleRuntimeCenter,
    },
  ]
  return (
    <section aria-labelledby="home-utility-heading" data-testid="home-utility-section">
      <h2 id="home-utility-heading" className="m-0 text-xl font-bold tracking-tight text-foreground">
        {t('home.tools.title')}
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {cards.map(card => (
          <button
            key={card.id}
            type="button"
            data-testid={`home-utility-${card.id}`}
            onClick={card.onClick}
            className="flex min-h-[82px] items-center gap-3 rounded-[13px] border border-foreground/10 bg-[var(--background-elevated)] p-4 text-left shadow-xs transition-all hover:-translate-y-px hover:shadow-minimal"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
              {card.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-foreground">{card.title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{card.description}</span>
            </span>
            <Icons.ChevronRight className="size-4 shrink-0 text-foreground/35" strokeWidth={1.5} />
          </button>
        ))}
      </div>
    </section>
  )
}

function AddExternalAppTile({ onClick }: { onClick: () => void }) {  const { t } = useTranslation()
  return (
    <button
      type="button"
      className="titlebar-no-drag group flex min-w-0 flex-col items-center gap-3 rounded-lg border border-transparent p-3 text-center outline-none transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground/10 hover:bg-foreground/4 hover:shadow-minimal focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      data-testid="add-external-app"
    >
      <span className="flex h-[76px] w-[76px] items-center justify-center rounded-lg border border-dashed border-foreground/20 bg-foreground/3 shadow-xs transition-all duration-200 ease-out group-hover:scale-[1.04] group-hover:border-accent/45 group-hover:bg-accent/8">
        <Icons.Plus className="h-8 w-8 text-foreground/55 group-hover:text-accent" strokeWidth={1.5} />
      </span>
      <span className="min-h-9 max-w-[112px] text-sm font-medium leading-[18px] text-foreground/70 group-hover:text-foreground">
        {t('homeApps.addExternal.title')}
      </span>
    </button>
  )
}

export function HomePage({ onAddApp, userName }: HomePageProps) {
  const { t, i18n } = useTranslation()
  const { installedApps, openApp, removeApp } = useTabShell()
  const catalog = useAppCatalog()
  const getStatus = catalog.getStatus
  const homeSlots = useHomeSurfaceSlots()
  const homeView = useHomeView()
  const view = homeView.view
  const resetHomeView = homeView.reset
  const [recentApps, setRecentApps] = useState<HomeRecentAppPreference[]>([])
  const recentLoadGenerationRef = useRef(0)
  const recentMutationGenerationRef = useRef(0)
  const [pinnedRefs, setPinnedRefs] = useState<PinnedHomeAppRef[]>([])
  const [hiddenRefs, setHiddenRefs] = useState<HiddenHomeAppRef[]>([])
  const [installTarget, setInstallTarget] = useState<{
    app: CatalogApp
    appConfigVersion: string
  } | null>(null)
  const installTargetApp = installTarget?.app ?? null
  const [uninstallTarget, setUninstallTarget] = useState<CatalogApp | null>(null)
  const [preserveData, setPreserveData] = useState(true)
  const [logsTarget, setLogsTarget] = useState<CatalogApp | null>(null)
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const logsRequestGenerationRef = useRef(0)
  const logsTargetScopeKeyRef = useRef<string | null>(null)
  const [organizationAppLimit, setOrganizationAppLimit] = useState(
    ORGANIZATION_APP_PAGE_SIZE,
  )

  const externalApps = useMemo(
    () => installedApps
      .filter(app => app.type === 'webapp' && !BUILTIN_APP_IDS.has(app.id))
      .sort((left, right) => left.order - right.order),
    [installedApps],
  )
  const builtinApps = useMemo(
    () => installedApps
      .filter(app => BUILTIN_APP_IDS.has(app.id))
      .sort((left, right) => left.order - right.order),
    [installedApps],
  )
  const organizationApps = useMemo(
    () => selectOrganizationAppsForDisplay(
      catalog.state.catalog,
      catalog.state.statuses,
      catalog.state.statusErrorScopeKeys,
    ),
    [
      catalog.state.catalog,
      catalog.state.statusErrorScopeKeys,
      catalog.state.statuses,
    ],
  )
  const activeOrganization = catalog.organization?.organizationSummaries.find(
    item => item.id === catalog.organization?.activeOrganizationId,
  )
  // 个人空间（我的空间 / 未加入组织）：首页展示常用区、我的圈子、个人快捷方式；
  // 企业空间只展示企业作品（D-PC-08），不放管理卡（D-PC-07）。
  const isPersonalSpace = !catalog.organization
    || activeOrganization?.type === 'creator_space'
  const recentContextKey = createHomeRecentContextKey(
    catalog.organization?.organizationContextKey,
  )

  // 圈子来源目录数据：与 ws-circles-account 的约定形状（CircleSourcedApp）。
  // 产品内真实来源数据待接入（.ws-requests/WS-HOME-APPS.md 台单），
  // 接入前目录页的圈子区不出现，去重逻辑单测与 demo 覆盖。
  const circleSourcedApps = useMemo<CircleSourcedApp[]>(() => [], [])
  const dedupedCircleApps = useMemo(
    () => dedupeCircleSourcedApps(circleSourcedApps),
    [circleSourcedApps],
  )

  useEffect(() => {
    const generation = recentLoadGenerationRef.current + 1
    recentLoadGenerationRef.current = generation
    const mutationGeneration = recentMutationGenerationRef.current
    setRecentApps([])
    // 本设备常用/隐藏偏好与最近记录同一上下文键：切空间时整组重置。
    setPinnedRefs(loadHomePinnedApps(recentContextKey))
    setHiddenRefs(loadHiddenHomeApps(recentContextKey))
    resetHomeView()
    void loadHomeRecentApps(recentContextKey)
      .then(apps => {
        // A local open in this same context fences the older hydration result:
        // launcher history may never move backwards after a user mutation.
        if (
          recentLoadGenerationRef.current === generation
          && recentMutationGenerationRef.current === mutationGeneration
        ) {
          setRecentApps(apps)
        }
      })
      .catch(() => {
        // Launcher history is non-critical; keep the current section usable.
      })
  }, [recentContextKey, resetHomeView])

  const pinnedIds = useMemo(
    () => new Set(pinnedRefs.map(ref => ref.id)),
    [pinnedRefs],
  )
  const hiddenIds = useMemo(
    () => new Set(hiddenRefs.map(ref => ref.id)),
    [hiddenRefs],
  )

  const recordRecent = useCallback((
    id: string,
    kind: HomeRecentAppKind,
  ) => {
    recentMutationGenerationRef.current += 1
    setRecentApps(current => {
      const next = [
        { id, kind, openedAt: Date.now() },
        ...current.filter(item => !(item.id === id && item.kind === kind)),
      ].slice(0, MAX_RECENT_APPS)
      void saveHomeRecentApps(recentContextKey, next).catch(() => {
        // Opening an App must not fail because preference persistence failed.
      })
      return next
    })
  }, [recentContextKey])

  const openPersonalApp = useCallback((app: AppDefinition) => {
    openApp(app)
    recordRecent(app.id, BUILTIN_APP_IDS.has(app.id) ? 'builtin' : 'external')
  }, [openApp, recordRecent])

  const openCatalogApp = useCallback(async (app: CatalogApp) => {
    if (app.availability !== 'available') {
      toast.error(t('homeApps.errors.unavailable'))
      return
    }
    try {
      const scopeKey = catalog.scopeKeyForApp(app)
      if (app.deliveryMode === 'remote_url') {
        const remoteUrl = await catalog.resolveRemoteUrl(app)
        openApp(catalogTabDefinition(scopeKey, app, remoteUrl))
      } else {
        const result = await catalog.start(app)
        openApp(catalogTabDefinition(scopeKey, app, result.url))
      }
      recordRecent(catalogRecentId(scopeKey), 'organization')
    } catch (error) {
      toast.error(t('homeApps.errors.openTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'open'),
      })
    }
  }, [catalog, openApp, recordRecent, t])

  const handlePrimaryAction = async (
    app: CatalogApp,
    action: CatalogPrimaryAction,
  ) => {
    if (action === 'install' || action === 'update') {
      const appConfigVersion = catalog.state.catalog?.appConfigVersion
      if (!appConfigVersion) {
        toast.error(t('homeApps.errors.staleContext'))
        return
      }
      setInstallTarget({ app, appConfigVersion })
      return
    }
    if (action === 'cancel') {
      try {
        await catalog.cancelInstall(app)
        toast.success(t('homeApps.toast.installCancelled', { name: app.name }))
      } catch (error) {
        toast.error(t('homeApps.errors.cancelInstall'), {
          description: homeAppOperationErrorText(t, error, 'cancel'),
        })
      }
      return
    }
    if (action === 'retry') {
      const status = getStatus(app)
      if (!status?.currentVersion) {
        const appConfigVersion = catalog.state.catalog?.appConfigVersion
        if (!appConfigVersion) {
          toast.error(t('homeApps.errors.staleContext'))
          return
        }
        setInstallTarget({ app, appConfigVersion })
        return
      }
    }
    if (action === 'open' || action === 'retry') {
      await openCatalogApp(app)
    }
  }

  const confirmInstall = async () => {
    const target = installTarget
    if (!target) return
    setInstallTarget(null)
    const { app, appConfigVersion } = target
    try {
      await catalog.install(app, appConfigVersion)
      toast.success(t('homeApps.toast.installed', { name: app.name }))
    } catch (error) {
      if (getHomeAppErrorCode(error) !== 'INSTALL_CANCELLED') {
        toast.error(t('homeApps.errors.installTitle', { name: app.name }), {
          description: homeAppOperationErrorText(t, error, 'install'),
        })
      }
    }
  }

  const handleStop = async (app: CatalogApp) => {
    try {
      await catalog.stop(app)
      toast.success(t('homeApps.toast.stopped', { name: app.name }))
    } catch (error) {
      toast.error(t('homeApps.errors.stopTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'stop'),
      })
    }
  }

  const confirmUninstall = async () => {
    const app = uninstallTarget
    if (!app) return
    setUninstallTarget(null)
    try {
      await catalog.uninstall(app, preserveData)
      toast.success(t('homeApps.toast.uninstalled', { name: app.name }))
    } catch (error) {
      toast.error(t('homeApps.errors.uninstallTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'uninstall'),
      })
    } finally {
      setPreserveData(true)
    }
  }

  const showLogs = async (app: CatalogApp) => {
    const scopeKey = catalog.scopeKeyForApp(app)
    const requestGeneration = logsRequestGenerationRef.current + 1
    logsRequestGenerationRef.current = requestGeneration
    logsTargetScopeKeyRef.current = scopeKey
    const isCurrentRequest = () => (
      logsRequestGenerationRef.current === requestGeneration
      && logsTargetScopeKeyRef.current === scopeKey
    )
    setLogsTarget(app)
    setLogs('')
    setLogsLoading(true)
    try {
      const nextLogs = await catalog.getLogs(app)
      if (isCurrentRequest()) setLogs(nextLogs)
    } catch (error) {
      if (isCurrentRequest()) {
        setLogs(homeAppOperationErrorText(t, error, 'logs'))
      }
    } finally {
      if (isCurrentRequest()) setLogsLoading(false)
    }
  }

  const compatibleWithHost = useCallback((app: CatalogApp): boolean => {
    if (app.deliveryMode !== 'local_bundle') return true
    const release = app.currentRelease
    const host = catalog.state.host
    if (!release || !host) return true
    return (!release.platform || release.platform === host.platform)
      && (!release.arch || release.arch === host.arch)
  }, [catalog.state.host])

  const scopeKeyForApp = catalog.scopeKeyForApp
  const scopeKeyFor = useCallback((app: CatalogApp): string | null => {
    try {
      return scopeKeyForApp(app)
    } catch {
      return null
    }
  }, [scopeKeyForApp])

  // ----- 常用（固定）应用：解析 + 偏好操作 -----

  const organizationAppByScopeKey = useMemo(() => {
    const map = new Map<string, CatalogApp>()
    for (const app of organizationApps) {
      const scopeKey = scopeKeyFor(app)
      if (scopeKey) map.set(scopeKey, app)
    }
    return map
  }, [organizationApps, scopeKeyFor])

  // 偏好变更走渲染快照 + 纯 set：localStorage 写与 toast 都在 updater 外
  //（updater 必须保持纯净，React 可能重复调用）。
  const togglePinnedTarget = (
    target: DirectoryPreferenceTarget,
    pinned: boolean,
  ) => {
    if (pinned) {
      setPinnedRefs(saveHomePinnedApps(
        recentContextKey,
        pinnedRefs.filter(ref => !(
          ref.kind === target.kind && ref.id === target.id
        )),
      ))
      return
    }
    if (pinnedRefs.length >= HOME_FREQUENT_APP_LIMIT) {
      toast.error(t('homeApps.manage.full'))
      return
    }
    if (pinnedRefs.some(ref => ref.kind === target.kind && ref.id === target.id)) {
      return
    }
    setPinnedRefs(saveHomePinnedApps(recentContextKey, [
      ...pinnedRefs,
      {
        id: target.id,
        kind: target.kind,
        name: target.name,
        iconUrl: target.iconUrl,
      },
    ]))
  }

  const removePinnedById = (id: string) => {
    setPinnedRefs(saveHomePinnedApps(
      recentContextKey,
      pinnedRefs.filter(ref => ref.id !== id),
    ))
  }

  const hideDirectoryTarget = (target: HidePreferenceTarget) => {
    if (hiddenRefs.some(ref => ref.kind === target.kind && ref.id === target.id)) {
      return
    }
    setHiddenRefs(saveHiddenHomeApps(recentContextKey, [
      ...hiddenRefs,
      { id: target.id, kind: target.kind, name: target.name },
    ]))
  }

  const restoreHiddenById = (id: string) => {
    setHiddenRefs(saveHiddenHomeApps(
      recentContextKey,
      hiddenRefs.filter(ref => ref.id !== id),
    ))
  }

  interface ResolvedPinnedEntry {
    key: string
    definition: AppDefinition
    onOpen: () => void
    item: ManageHomeAppItem
  }

  const resolvedPinned = useMemo<ResolvedPinnedEntry[]>(() => {
    const entries: ResolvedPinnedEntry[] = []
    for (const ref of pinnedRefs) {
      if (ref.kind === 'external') {
        const app = installedApps.find(candidate => candidate.id === ref.id)
        if (!app) continue
        entries.push({
          key: `pinned:external:${app.id}`,
          definition: app,
          onOpen: () => openPersonalApp(app),
          item: { id: ref.id, name: app.name, iconUrl: app.iconUrl, kind: ref.kind },
        })
        continue
      }
      if (ref.kind === 'organization') {
        const app = organizationAppByScopeKey.get(ref.id)
        if (!app || app.availability !== 'available') continue
        const status = getStatus(app)
        const url = app.remoteUrl || status?.url || 'http://127.0.0.1'
        entries.push({
          key: `pinned:organization:${ref.id}`,
          definition: catalogTabDefinition(ref.id, app, url),
          onOpen: () => { void openCatalogApp(app) },
          item: { id: ref.id, name: app.name, iconUrl: app.iconUrl, kind: ref.kind },
        })
        continue
      }
      // 圈子来源条目：产品内尚未接入真实数据（见 circleSourcedApps 注释）。
    }
    return entries
  }, [
    getStatus,
    installedApps,
    openCatalogApp,
    openPersonalApp,
    organizationAppByScopeKey,
    pinnedRefs,
  ])

  const resolvedRecent = (() => {
    const entries: Array<{
      key: string
      definition: AppDefinition
      onOpen: () => void
    }> = []
    const seen = new Set<string>()

    for (const item of recentApps) {
      // 个人空间里 Polo 助手已固定在常用区（D-PC-07），最近记录不再重复它。
      if (isPersonalSpace && item.kind === 'builtin') continue
      if (item.kind === 'organization') {
        const app = organizationApps.find(candidate => {
          try {
            return catalogRecentId(catalog.scopeKeyForApp(candidate)) === item.id
          } catch {
            return false
          }
        })
        if (!app || app.availability !== 'available') continue
        const status = getStatus(app)
        const url = app.remoteUrl || status?.url || 'http://127.0.0.1'
        const scopeKey = catalog.scopeKeyForApp(app)
        const key = `organization:${scopeKey}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({
          key,
          definition: catalogTabDefinition(scopeKey, app, url),
          onOpen: () => { void openCatalogApp(app) },
        })
        continue
      }
      const app = installedApps.find(candidate => candidate.id === item.id)
      if (!app) continue
      const key = `${item.kind}:${app.id}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({
        key,
        definition: app,
        onOpen: () => openPersonalApp(app),
      })
    }

    return entries.slice(0, MAX_RECENT_APPS)
  })()
  const remainingBuiltinApps = builtinApps.filter(app => (
    !(isPersonalSpace && app.id === POLO_APP_DEFINITION.id)
    && !resolvedRecent.some(item => item.key === `builtin:${app.id}`)
  ))

  useEffect(() => {
    setOrganizationAppLimit(ORGANIZATION_APP_PAGE_SIZE)
  }, [
    catalog.organization?.organizationContextKey,
    catalog.state.catalog?.appConfigVersion,
  ])
  useEffect(() => {
    // Logs are scoped to the exact account/organization/App tuple. Advancing
    // this independent request generation prevents an older organization
    // context from publishing into a later dialog.
    logsRequestGenerationRef.current += 1
    logsTargetScopeKeyRef.current = null
    setLogsTarget(null)
    setLogs('')
    setLogsLoading(false)
  }, [catalog.organization?.organizationContextKey])

  const hiddenOrganizationScopeKeys = useMemo(() => new Set(hiddenRefs
    .filter(ref => ref.kind === 'organization')
    .map(ref => ref.id)), [hiddenRefs])

  const visibleOrganizationApps = useMemo(
    () => organizationApps.filter(app => {
      const scopeKey = scopeKeyFor(app)
      return scopeKey === null || !hiddenOrganizationScopeKeys.has(scopeKey)
    }),
    [hiddenOrganizationScopeKeys, organizationApps, scopeKeyFor],
  )
  const displayedOrganizationApps = visibleOrganizationApps.slice(
    0,
    organizationAppLimit,
  )

  // ----- 目录页 / 管理页数据 -----

  const directoryCircleEntries = useMemo<CircleDirectoryEntry[]>(
    () => dedupedCircleApps
      .filter(entry => !hiddenIds.has(entry.appId))
      .map(entry => ({ ...entry, pinned: pinnedIds.has(entry.appId) })),
    [dedupedCircleApps, hiddenIds, pinnedIds],
  )

  const directoryOrganizationEntries = useMemo<OrganizationDirectoryEntry[]>(() => {
    const entries: OrganizationDirectoryEntry[] = []
    for (const app of visibleOrganizationApps) {
      const scopeKey = scopeKeyFor(app)
      if (scopeKey === null) continue
      const status = getStatus(app)
      entries.push({
        id: scopeKey,
        app,
        status,
        statusLoading: Boolean(
          catalog.state.statusLoadingScopeKeys?.[scopeKey],
        ),
        statusUnavailable: Boolean(
          !status
          && !catalog.state.statusLoadingScopeKeys?.[scopeKey]
          && catalog.state.statusErrorScopeKeys?.[scopeKey],
        ),
        compatible: compatibleWithHost(app),
        offline: catalog.state.accessMode === 'offline',
        pinned: pinnedIds.has(scopeKey),
      })
    }
    return entries
  }, [
    compatibleWithHost,
    getStatus,
    pinnedIds,
    scopeKeyFor,
    catalog.state.accessMode,
    catalog.state.statusErrorScopeKeys,
    catalog.state.statusLoadingScopeKeys,
    visibleOrganizationApps,
  ])

  const manageCandidates = useMemo<ManageHomeAppItem[]>(() => {
    const pinnedKeys = new Set(pinnedRefs.map(ref => `${ref.kind}:${ref.id}`))
    const items: ManageHomeAppItem[] = []
    for (const app of visibleOrganizationApps) {
      if (app.availability !== 'available') continue
      const scopeKey = scopeKeyFor(app)
      if (scopeKey === null) continue
      if (pinnedKeys.has(`organization:${scopeKey}`)) continue
      items.push({
        id: scopeKey,
        name: app.name,
        iconUrl: app.iconUrl,
        kind: 'organization',
      })
    }
    for (const app of externalApps) {
      if (pinnedKeys.has(`external:${app.id}`)) continue
      items.push({
        id: app.id,
        name: app.name,
        iconUrl: app.iconUrl,
        kind: 'external',
      })
    }
    return items
  }, [externalApps, pinnedRefs, scopeKeyFor, visibleOrganizationApps])

  // 管理页已固定列表来自原始偏好（不是首页可解析子集）：被撤下/卸载的
  // 固定项也占名额，必须可见、可移除——否则配额会被幽灵项占死。
  const managePinned = useMemo<ManageHomeAppItem[]>(() => (
    pinnedRefs.map(ref => {
      if (ref.kind === 'external') {
        const app = installedApps.find(candidate => candidate.id === ref.id)
        return {
          id: ref.id,
          name: app?.name ?? ref.name ?? ref.id,
          iconUrl: app?.iconUrl ?? ref.iconUrl,
          kind: ref.kind,
        }
      }
      if (ref.kind === 'organization') {
        const app = organizationAppByScopeKey.get(ref.id)
        return {
          id: ref.id,
          name: app?.name ?? ref.name ?? ref.id,
          iconUrl: app?.iconUrl ?? ref.iconUrl,
          kind: ref.kind,
        }
      }
      return {
        id: ref.id,
        name: ref.name ?? ref.id,
        iconUrl: ref.iconUrl,
        kind: ref.kind,
      }
    })
  ), [installedApps, organizationAppByScopeKey, pinnedRefs])

  const hiddenListItems = useMemo<HiddenAppItem[]>(() => (
    hiddenRefs.map(ref => {
      if (ref.kind === 'organization') {
        const app = organizationAppByScopeKey.get(ref.id)
        return {
          id: ref.id,
          name: app?.name ?? ref.name ?? ref.id,
          iconUrl: app?.iconUrl,
          sourceLabel: activeOrganization?.name,
        }
      }
      return {
        id: ref.id,
        name: ref.name ?? ref.id,
        sourceLabel: t('homeApps.allApps.circleSection'),
      }
    })
  ), [
    activeOrganization?.name,
    hiddenRefs,
    organizationAppByScopeKey,
    t,
  ])

  const inspectorTarget = useMemo<AppInspectorTarget | null>(() => {
    if (view.kind !== 'inspector') return null
    if (view.source === 'circle') {
      const entry = dedupedCircleApps.find(candidate => (
        candidate.appId === view.id
      ))
      if (!entry) return null
      return {
        name: entry.name,
        iconUrl: entry.iconUrl,
        sources: entry.sources.map(source => ({
          label: source.circleName,
          detail: source.creator,
          valid: source.valid,
        })),
        statusLabel: entry.blocked
          ? t('homeApps.allApps.blocked')
          : t('homeApps.inspector.statusAvailable'),
        statusTone: entry.blocked ? 'destructive' : 'success',
        blockedPath: entry.blocked
          ? t('homeApps.inspector.blockedPath')
          : undefined,
      }
    }
    const app = organizationAppByScopeKey.get(view.id)
    if (!app) return null
    const status = getStatus(app)
    const blocked = app.availability !== 'available'
    return {
      name: app.name,
      iconUrl: app.iconUrl,
      sources: [{
        label: activeOrganization?.name || t('homeApps.organization.current'),
        valid: !blocked,
      }],
      version: status?.currentVersion ?? app.currentRelease?.version,
      statusLabel: statusText(t, app, status, compatibleWithHost(app)),
      statusTone: blocked || status?.status === 'broken'
        ? 'destructive'
        : status?.status === 'running' ? 'success' : 'info',
      statusReason: blocked
        ? (
            app.availability === 'withdrawn'
              ? t('homeApps.status.withdrawn')
              : t('homeApps.status.unauthorized')
          )
        : status?.error
          ? homeAppOperationErrorText(t, status.error, 'open')
          : undefined,
      blockedPath: blocked
        ? t('homeApps.inspector.blockedPath')
        : undefined,
      permissions: app.permissions,
    }
  }, [
    activeOrganization?.name,
    getStatus,
    compatibleWithHost,
    dedupedCircleApps,
    organizationAppByScopeKey,
    t,
    view,
  ])

  const syncedAtText = formatCatalogSyncedAt(
    i18n.language,
    catalog.state.catalog?.syncedAt,
  )

  const orgSection = catalog.organization && (
    <section aria-labelledby="organization-apps-heading" data-testid="organization-apps-section">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h2 id="organization-apps-heading" className="text-base font-semibold">
            {t('homeApps.frequent.appsTitle')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('homeApps.frequent.appsSubtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={homeView.openAllApps}
          >
            {t('homeApps.allApps.title')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={catalog.state.refreshing}
            onClick={() => { void catalog.sync(true) }}
          >
            <Icons.RefreshCw className={catalog.state.refreshing ? 'animate-spin' : ''} />
            {t('homeApps.actions.refresh')}
          </Button>
        </div>
      </div>

      {catalog.state.warningCode && catalog.state.accessMode !== 'offline' && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <Icons.WifiOff className="size-4 shrink-0" />
          {catalogStateMessage(t, catalog.state.warningCode, 'warning')}
        </div>
      )}

      {catalog.state.accessMode === 'offline' && !catalog.state.loading && (
        <div className="mb-4">
          <OfflineDirectoryState
            description={t('homeApps.organization.offlineWarning')}
            fetchedAtLine={syncedAtText
              ? t('homeApps.offline.syncedAt', { time: syncedAtText })
              : t('homeApps.offline.title')}
          />
        </div>
      )}

      {catalog.state.statusErrorCode && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span className="flex items-center gap-2">
            <Icons.CircleAlert className="size-4 shrink-0" />
            {t('homeApps.errors.statusReadFailed')}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { void catalog.refreshRuntimeStatuses() }}
          >
            {t('homeApps.actions.tryAgain')}
          </Button>
        </div>
      )}

      {catalog.state.loading ? (
        <div className="flex min-h-32 items-center justify-center rounded-xl border border-foreground/10">
          <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : catalog.state.errorCode && !catalog.state.catalog ? (
        <DirectoryLoadFailedState
          title={t('homeApps.organization.loadFailed')}
          description={catalogStateMessage(t, catalog.state.errorCode, 'error')}
          retryLabel={t('homeApps.actions.tryAgain')}
          onRetry={() => { void catalog.sync(true) }}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <HomeAssistantCard onOpenAssistant={() => openPersonalApp(POLO_APP_DEFINITION)} />
            {displayedOrganizationApps.map(app => {
              const scopeKey = scopeKeyFor(app)
              if (scopeKey === null) return null
              const status = getStatus(app)
              const blocked = app.availability !== 'available'
              return (
                <div
                  key={scopeKey}
                  className={blocked ? 'flex flex-col gap-2' : undefined}
                >
                  <OrganizationAppCard
                    app={app}
                    status={status}
                    statusLoading={Boolean(
                      catalog.state.statusLoadingScopeKeys?.[scopeKey],
                    )}
                    statusUnavailable={Boolean(
                      !status
                      && !catalog.state.statusLoadingScopeKeys?.[scopeKey]
                      && catalog.state.statusErrorScopeKeys?.[scopeKey],
                    )}
                    compatible={compatibleWithHost(app)}
                    offline={catalog.state.accessMode === 'offline'}
                    onPrimaryAction={(target, action) => {
                      void handlePrimaryAction(target, action)
                    }}
                    onStop={(target) => { void handleStop(target) }}
                    onUninstall={setUninstallTarget}
                    onViewLogs={(target) => { void showLogs(target) }}
                  />
                  {blocked && (
                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => homeView.inspectApp(scopeKey, 'organization')}
                      >
                        {t('homeApps.allApps.viewReason')}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {visibleOrganizationApps.length === 0 && (
            <div className="mt-4">
              <EmptyDirectoryState
                title={t('homeApps.organization.empty')}
                description={t('homeApps.organization.emptyEnterprise')}
              />
            </div>
          )}
          {displayedOrganizationApps.length < visibleOrganizationApps.length && (
            <div className="mt-5 flex justify-center">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOrganizationAppLimit(current => (
                    current + ORGANIZATION_APP_PAGE_SIZE
                  ))
                }}
              >
                {t('homeApps.actions.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )

  const homeSurface = (
    <>
      {/* 原型 P-M03 home-hero：问候 + 「继续 {空间} 的工作」；个人空间右侧
          挂「我的圈子」入口（ws-circles-account 插槽）。 */}
      <HomeHero
        userName={userName}
        spaceName={
          isPersonalSpace
            ? t('home.hero.personalSpace')
            : (activeOrganization?.name || t('home.hero.personalSpace'))
        }
        circlesSlot={isPersonalSpace ? homeSlots.circlesEntry : undefined}
      />

      {isPersonalSpace && (
        <section aria-labelledby="frequent-apps-heading" data-testid="home-frequent-section">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h1 id="frequent-apps-heading" className="text-lg font-semibold">
                {t('homeApps.frequent.appsTitle')}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('homeApps.frequent.appsSubtitle')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={homeView.openManage}
              >
                {t('homeApps.frequent.manage')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={homeView.openAllApps}
              >
                {t('homeApps.allApps.title')}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 md:grid-cols-6">
            {/* Polo 助手固定在首页、不占常用名额（D-PC-07 M03 收口）。 */}
            <div data-testid="home-assistant-card">
              <AppIcon
                app={POLO_APP_DEFINITION}
                onOpen={openPersonalApp}
              />
            </div>
            {resolvedPinned.slice(0, HOME_FREQUENT_APP_LIMIT).map(entry => (
              <AppIcon
                key={entry.key}
                app={entry.definition}
                onOpen={entry.onOpen}
              />
            ))}
          </div>
          {resolvedPinned.length === 0 && (
            <ZeroFrequentState
              title={t('homeApps.frequent.zeroTitle')}
              description={t('homeApps.frequent.zeroDescription')}
              actionLabel={t('homeApps.frequent.zeroAction')}
              onAction={homeView.openAllApps}
            />
          )}
        </section>
      )}

      {/* 企业空间常用 Apps（P-M03-HOME-ENT）：助手大卡 + 企业作品统一栅格。 */}
      {orgSection}

      {/* 系统工具（原型 P-M03 utility-grid）：文件 / 任务与结果。 */}
      <HomeUtilitySection onOpenFiles={() => openPersonalApp(POLO_APP_DEFINITION)} />

      {isPersonalSpace && (
        <section aria-labelledby="recent-apps-heading">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 id="recent-apps-heading" className="text-base font-semibold">
                {t('homeApps.recent.title')}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('homeApps.recent.description')}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 md:grid-cols-6">
            {resolvedRecent.map(item => (
              <AppIcon
                key={item.key}
                app={item.definition}
                onOpen={item.onOpen}
              />
            ))}
          </div>
          {remainingBuiltinApps.length > 0 && (
            <div
              className="rounded-xl border border-foreground/10 bg-foreground/2 p-4"
              data-testid="builtin-app-launcher"
            >
              <h2 className="text-sm font-medium">{t('homeApps.builtin.title')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('homeApps.builtin.description')}
              </p>
              <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 md:grid-cols-6">
                {remainingBuiltinApps.map(app => (
                  <AppIcon
                    key={app.id}
                    app={app}
                    onOpen={openPersonalApp}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {isPersonalSpace && (
        <section aria-labelledby="external-apps-heading">
          <div className="mb-4">
            <h2 id="external-apps-heading" className="text-base font-semibold">
              {t('homeApps.external.title')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('homeApps.external.description')}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 md:grid-cols-6">
            {externalApps.map(app => (
              <AppIcon
                key={app.id}
                app={app}
                onOpen={openPersonalApp}
                onRemove={(target) => { void removeApp(target.id) }}
              />
            ))}
            <AddExternalAppTile onClick={onAddApp} />
          </div>
        </section>
      )}
    </>
  )

  return (
    <main
      className="h-full min-h-0 overflow-y-auto bg-background px-6 py-8 text-foreground sm:px-8"
      data-testid="home-app-hub"
    >
      <div className="mx-auto w-full max-w-[1120px] space-y-10">
        {view.kind === 'home' && homeSurface}

        {view.kind === 'all-apps' && (
          <AllAppsPage
            onBack={homeView.goHome}
            loading={Boolean(catalog.organization) && catalog.state.loading}
            organizationEntries={directoryOrganizationEntries}
            circleEntries={directoryCircleEntries}
            hiddenCount={hiddenRefs.length}
            onViewHidden={homeView.openHidden}
            onTogglePinned={togglePinnedTarget}
            onHide={hideDirectoryTarget}
            onInspectOrganization={(entry) => {
              homeView.inspectApp(entry.id, 'organization')
            }}
            onInspectCircle={(entry) => {
              homeView.inspectApp(entry.appId, 'circle')
            }}
            onOpenCircleApp={undefined}
            onOrganizationPrimaryAction={(target, action) => {
              void handlePrimaryAction(target, action)
            }}
            onOrganizationStop={(target) => { void handleStop(target) }}
            onOrganizationUninstall={setUninstallTarget}
            onOrganizationViewLogs={(target) => { void showLogs(target) }}
            emptyState={(
              <EmptyDirectoryState
                title={t('homeApps.allApps.emptyTitle')}
                description={isPersonalSpace
                  ? t('homeApps.allApps.emptyDescription')
                  : t('homeApps.allApps.emptyEnterpriseDescription')}
              />
            )}
          />
        )}

        {view.kind === 'inspector' && (
          inspectorTarget
            ? (
              <AppInspector
                target={inspectorTarget}
                onBack={homeView.goHome}
                onOpen={() => {
                  if (view.kind !== 'inspector') return
                  const app = organizationAppByScopeKey.get(view.id)
                  if (app) void openCatalogApp(app)
                }}
              />
            )
            : (
              <div className="space-y-4">
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={homeView.goHome}
                  >
                    <Icons.ArrowLeft className="size-4" strokeWidth={1.5} />
                    {t('homeApps.allApps.back')}
                  </Button>
                </div>
                <EmptyDirectoryState
                  title={t('homeApps.inspector.unavailableTitle')}
                  description={t('homeApps.inspector.unavailableDescription')}
                />
              </div>
            )
        )}

        {view.kind === 'manage' && (
          <ManageHomeApps
            pinned={managePinned}
            candidates={manageCandidates}
            onRemove={removePinnedById}
            onAdd={item => togglePinnedTarget(item, false)}
            onViewHidden={homeView.openHidden}
            onBack={homeView.goHome}
          />
        )}

        {view.kind === 'hidden' && (
          <HiddenApps
            hidden={hiddenListItems}
            onRestore={restoreHiddenById}
            onBack={homeView.openManage}
          />
        )}
      </div>

      <Dialog open={Boolean(installTarget)} onOpenChange={(open) => {
        if (!open) setInstallTarget(null)
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {installTargetApp && catalog.getStatus(installTargetApp)?.availableRelease
                ? t('homeApps.install.updateTitle', {
                    name: installTargetApp.name,
                  })
                : t('homeApps.install.installTitle', {
                    name: installTargetApp?.name ?? t('homeApps.appFallback'),
                  })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.install.description')}
            </DialogDescription>
          </DialogHeader>
          {installTargetApp?.currentRelease && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-foreground/4 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.version')}
                  </p>
                  <p className="mt-1 font-medium">{installTargetApp.currentRelease.version}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.downloadSize')}
                  </p>
                  <p className="mt-1 font-medium">
                    {formatBytes(t, installTargetApp.currentRelease.sizeBytes)}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('homeApps.install.permissions')}
                </p>
                {installTargetApp.permissions?.length ? (
                  <ul className="mt-2 space-y-1.5">
                    {installTargetApp.permissions.map(permission => (
                      <li key={permission} className="flex items-start gap-2">
                        <Icons.ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span>{permission}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-muted-foreground">
                    {t('homeApps.install.noPermissions')}
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setInstallTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={() => { void confirmInstall() }}>
              {installTargetApp && catalog.getStatus(installTargetApp)?.availableRelease
                ? t('homeApps.actions.update')
                : t('homeApps.actions.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(uninstallTarget)} onOpenChange={(open) => {
        if (!open) {
          setUninstallTarget(null)
          setPreserveData(true)
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('homeApps.uninstall.title', {
                name: uninstallTarget?.name ?? t('homeApps.appFallback'),
              })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.uninstall.description')}
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-foreground/10 p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={preserveData}
              onChange={event => setPreserveData(event.target.checked)}
            />
            <span>
              <span className="block font-medium">
                {t('homeApps.uninstall.keepData')}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t('homeApps.uninstall.keepDataDescription')}
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setUninstallTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={() => { void confirmUninstall() }}>
              {t('homeApps.actions.uninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(logsTarget)} onOpenChange={(open) => {
        if (!open) {
          logsRequestGenerationRef.current += 1
          logsTargetScopeKeyRef.current = null
          setLogsTarget(null)
          setLogs('')
          setLogsLoading(false)
        }
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t('homeApps.logs.title', {
                name: logsTarget?.name ?? t('homeApps.appFallback'),
              })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.logs.description')}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[420px] min-h-40 overflow-auto rounded-lg bg-foreground/5 p-3 text-xs leading-relaxed">
            {logsLoading
              ? t('homeApps.logs.loading')
              : logs || t('homeApps.logs.empty')}
          </pre>
        </DialogContent>
      </Dialog>
    </main>
  )
}
