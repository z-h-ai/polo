import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as Icons from 'lucide-react'
import { MemberAppCard } from '@/components/tab-browser/MemberAppCard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { AppCatalogInstance } from '@/hooks/useAppCatalog'
import { useMemberAppActions } from '@/hooks/useMemberAppActions'
import type { ProductSpaceAppLaunchHandoff } from '@/context/ProductSpaceContext'
import type { MemberCirclesReadPhase } from '@/hooks/useMemberCircles'
import type { MemberCircleDetailView } from '@/lib/member-circle-view'
import { formatBytes } from '@/lib/home-app-usage'
import type {
  HomeAppDirectory,
  HomeAppDirectoryEntry,
  HomeAppDirectorySource,
} from '@/lib/home-app-directory'
import {
  CircleSkillSummary,
  countCircleAppClassEntitlements,
  selectCircleSkillSummaries,
} from './CircleSkillSummary'

/**
 * POO-70 C4 (P70-CIRCLE-CONTENT-01/02/03) — the circle detail CONTENT panel
 * (应用 / 技能 two sections), mounted by C9's CircleDetailPage for the
 * `content` section of a `circle-detail` route.
 *
 * Authority contract:
 * - Apps are projected from the SAME personal Catalog projection the home
 *   uses (the H1 `selectHomeAppDirectory` result is passed in via
 *   `context.directory`), filtered to rows whose authoritative
 *   `catalogSources` contain a `kind='creator_circle'` source whose
 *   `circleId` matches THIS circle. The projection keeps the COMPLETE
 *   identity (catalogEntryId / artifactInstanceId / stable version) and ALL
 *   recorded sources on every row for the open flow — it never guesses an
 *   artifactInstanceId from a `me/circles` entitlements artifactId.
 * - Skills render read-only through CircleSkillSummary (C1 receipt material).
 *   No detail/management/enablement/install/assistant entry exists in this
 *   batch, and no 查看全部应用 / 管理本机技能 large buttons are rendered
 *   (§13.11).
 * - The open action is the SHARED H2 flow (`useMemberAppActions`, injected
 *   catalog instance): cached rows never launch by themselves — the
 *   directory-level phase and the per-row `launchBlocked` fact fail closed
 *   here with visible feedback, and the authoritative grant stays inside
 *   `resolveLaunch`. `launchBlocked` covers per-row facts only; consumers
 *   must combine it with the directory phase, which this panel does.
 * - Feedback stays accurate (P70-CIRCLE-CONTENT-03): an exited circle
 *   (`unknown_circle` in the C2 receipt) renders NO rows at all — nothing
 *   can launch through a cache; a circle whose receipt lists app-class
 *   entitlements that the trusted Catalog cannot verify renders an explicit
 *   partial note instead of fabricated rows; C2's `partial` relations phase
 *   and the directory phases (loading/denied/offline/error/rejected) each
 *   keep their distinct explanation. Works that keep ANOTHER valid source
 *   stay openable from 我的应用 (H1 keeps those rows launchable) — this
 *   panel only refuses what THIS circle can no longer prove.
 */

export interface CircleContentPanelContextValue {
  /**
   * The H1 projection (`selectHomeAppDirectory`) of the CURRENT space's
   * authoritative Catalog — the same instance the home consumes. The panel
   * never builds its own catalog read surface.
   */
  directory: HomeAppDirectory
  /** THE shared catalog instance, injected into the shared open actions. */
  catalog: AppCatalogInstance
  spaceKind: 'personal' | 'enterprise' | null
  /** The existing launch handoff surface (same instance the home publishes through). */
  launchHandoff: ProductSpaceAppLaunchHandoff
  /**
   * C2 relations phase when the holder wants the panel to explain a partial
   * authoritative read (one of the two relations reads failed). Null/absent
   * renders no relations banner; the partial fact is never faked into ready.
   */
  relationsPhase?: MemberCirclesReadPhase | null
  /** Explicit relations retry wired by the holder (C2 `refresh`); optional. */
  onRefreshRelations?: () => void
}

export interface CircleContentPanelProps {
  /** C2 `getCircle(circleId)` projection for THIS scope's relations. */
  circle: MemberCircleDetailView
  context: CircleContentPanelContextValue
}

/** One projected app row: the H1 entry plus THIS circle's matched source. */
export interface CircleContentAppRow {
  entry: HomeAppDirectoryEntry
  circleSource: HomeAppDirectorySource
}

/**
 * Pure circle-content projection over the H1 directory: rows with a
 * creator_circle source whose circleId matches THIS circle. A source whose
 * authorization the member-circle authority reports lost stays in the
 * projection (H1 keeps such rows visible for explanation) — the row then
 * carries the lost-source explanation and is not launchable unless another
 * valid source remains (H1 `launchBlocked`).
 */
export function selectCircleContentApps(
  directory: HomeAppDirectory,
  circleId: string,
): CircleContentAppRow[] {
  if (!circleId) return []
  const rows: CircleContentAppRow[] = []
  for (const entry of directory.entries) {
    const circleSource = entry.sources.find(
      source => source.kind === 'creator_circle' && source.circleId === circleId,
    )
    if (circleSource) rows.push({ entry, circleSource })
  }
  return rows
}

/** User-facing unavailability reason kind for one projected row. */
export type CircleContentAppReason =
  | 'circle_source_lost'
  | 'authorization_ended'
  | 'space_restricted'
  | 'version_unavailable'
  | 'version_blocked'
  | 'withdrawn'
  | 'generic'

export function circleAppRowUnavailableReason(
  row: CircleContentAppRow,
): CircleContentAppReason | null {
  if (!row.circleSource.valid && row.circleSource.refusal === 'circle_authorization_lost') {
    return 'circle_source_lost'
  }
  if (!row.entry.launchBlocked) return null
  if (row.entry.rawAvailability === 'withdrawn') return 'withdrawn'
  switch (row.entry.app.unavailableReason) {
    case 'authorization_ended': return 'authorization_ended'
    case 'space_restricted': return 'space_restricted'
    case 'version_unavailable': return 'version_unavailable'
    case 'version_blocked': return 'version_blocked'
    default: return 'generic'
  }
}

export function CircleContentPanel({ circle, context }: CircleContentPanelProps) {
  const { t } = useTranslation()
  const { directory, catalog, spaceKind, launchHandoff, relationsPhase, onRefreshRelations } = context

  // H2 shared actions: open / prepare / permission feedback through the SAME
  // trusted flow the home drives, on the SAME injected catalog instance.
  const memberActions = useMemberAppActions({
    context: { spaceKind, launchHandoff },
    catalog,
  })
  const prepareTargetApp = memberActions.prepareTarget?.app ?? null

  const circleId = circle.availability === 'ready' ? circle.circle.circle.circleId : null

  const rows = useMemo(
    () => selectCircleContentApps(directory, circleId ?? ''),
    [directory, circleId],
  )
  const skills = useMemo(
    () => (circle.availability === 'ready' ? selectCircleSkillSummaries(circle.entitlements) : []),
    [circle],
  )
  const appClassEntitlements = useMemo(
    () => (circle.availability === 'ready' ? countCircleAppClassEntitlements(circle.entitlements) : 0),
    [circle],
  )

  // Open handler: the fail-closed gate, identical in shape to the home's.
  // Cached rows never carry launch authority; the grant stays with
  // resolveLaunch inside the shared action.
  const handleOpenApp = useCallback((row: CircleContentAppRow) => {
    if (directory.phase !== 'ready') {
      if (directory.phase === 'offline') {
        toast.error(t('homeApps.organization.offlineWarning'))
      } else {
        toast.error(t('homeApps.errors.unavailable'))
      }
      return
    }
    if (row.entry.launchBlocked) {
      toast.error(t('homeApps.errors.unavailable'))
      return
    }
    void memberActions.open(row.entry.app)
  }, [directory.phase, memberActions, t])

  // P70-CIRCLE-CONTENT-03: an exited circle is `unknown_circle` in THIS
  // scope's authoritative receipt. It renders NO rows — nothing may launch
  // through a stale cache. Works that still have another valid source stay
  // openable from 我的应用 (the H1 directory keeps those rows launchable).
  if (circle.availability === 'unknown_circle') {
    return (
      <div
        className="mt-[16px] grid justify-items-center gap-[10px] rounded-[20px] border border-dashed border-border px-[20px] py-[34px] text-center"
        data-testid="circle-content-exited"
      >
        <span className="grid size-[52px] place-items-center rounded-[14px] bg-muted text-muted-foreground">
          <Icons.UserRoundX className="size-[25px]" aria-hidden="true" />
        </span>
        <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">
          {t('poo70.c4.content.exitedTitle')}
        </h2>
        <p className="m-0 max-w-[460px] text-[12px] leading-[1.5] text-muted-foreground">
          {t('poo70.c4.content.exitedHint')}
        </p>
      </div>
    )
  }

  // circle.availability === 'ready' below this line.
  const circleStatus = circle.circle.circle.status
  const catalogPhase = directory.phase
  // H1 reviewer contract: an `empty` phase consumed WITHOUT its rejections is
  // NOT a vacuum — a fully-rejected directory keeps its own explanation. A
  // clean `empty` (no rejections) is an authoritative space vacuum, so it may
  // back the circle's honest empty/partial derivations below; every failure
  // phase may not.
  const directoryRejected = catalogPhase === 'empty' && directory.rejections.length > 0
  const directoryVerifiable = catalogPhase === 'ready' || (catalogPhase === 'empty' && !directoryRejected)
  // Count-based explicit partial (P70-CIRCLE-CONTENT-03 / card step 1): the
  // receipt lists app-class entitlements the trusted Catalog cannot verify.
  // Identity-level mapping (which entitlement is missing) is upstream-expected
  // (F1/C1) — without it the feedback stays count-based and nothing is
  // fabricated.
  const appsUnverified = directoryVerifiable && appClassEntitlements > rows.length
  // Honest vacuum: a verifiable directory, no projected rows, no skills, and
  // the receipt itself lists no app-class works (an empty receipt is
  // legitimate — G8 — never upgraded into an error).
  const contentEmpty = directoryVerifiable
    && rows.length === 0 && skills.length === 0 && appClassEntitlements === 0

  return (
    <div className="mt-[20px]" data-testid="circle-content-panel">
      {circleStatus !== 'active' && (
        <div
          className="rounded-[13px] border border-info/25 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-content-circle-status"
          data-circle-status={circleStatus}
        >
          {t(`poo70.c4.content.circleStatus.${circleStatus}`)}
        </div>
      )}
      {relationsPhase === 'partial' && (
        <div
          className="mt-[12px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-content-relations-partial"
        >
          <span>{t('poo70.c4.content.relationsPartial')}</span>
          {onRefreshRelations && (
            <button
              type="button"
              data-testid="circle-content-relations-retry"
              className="inline-flex min-h-[28px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
              onClick={onRefreshRelations}
            >
              {t('homeApps.actions.tryAgain')}
            </button>
          )}
        </div>
      )}

      {contentEmpty ? (
        <div
          className="mt-[16px] grid justify-items-center gap-[10px] rounded-[20px] border border-dashed border-border px-[20px] py-[34px] text-center"
          data-testid="circle-content-empty"
        >
          <span className="grid size-[52px] place-items-center rounded-[14px] bg-info/10 text-info">
            <Icons.LayoutGrid className="size-[25px]" aria-hidden="true" />
          </span>
          <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">
            {t('poo70.c4.content.emptyTitle')}
          </h2>
          <p className="m-0 max-w-[460px] text-[12px] leading-[1.5] text-muted-foreground">
            {t('poo70.c4.content.emptyHint')}
          </p>
        </div>
      ) : (
        <>
          {/* ── 应用 ─────────────────────────────────────────────────── */}
          <section className="mt-[8px]" data-testid="circle-content-apps-section">
            <h2 className="m-0 text-[16px] font-bold tracking-[-0.01em]">
              {t('poo70.c4.content.appsTitle')}
            </h2>

            {catalogPhase === 'loading' && (
              <div
                className="mt-[12px] flex items-center gap-[8px] rounded-[13px] border border-border px-4 py-3 text-xs text-muted-foreground"
                data-testid="circle-content-loading"
              >
                <Icons.LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                {t('poo70.c4.content.loading')}
              </div>
            )}
            {catalogPhase === 'offline' && (
              <div
                className="mt-[12px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
                data-testid="circle-content-offline"
              >
                {t('homeApps.organization.offlineWarning')}
              </div>
            )}
            {catalogPhase === 'denied' && (
              <div
                className="mt-[12px] rounded-[13px] border border-danger/25 bg-danger/8 px-4 py-3 text-xs text-danger"
                data-testid="circle-content-denied"
              >
                {t('homeApps.organization.accessError')}
              </div>
            )}
            {catalogPhase === 'error' && (
              <div
                className="mt-[12px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
                data-testid="circle-content-error"
              >
                <span>{t('homeApps.allApps.loadFailed')}</span>
                <button
                  type="button"
                  data-testid="circle-content-catalog-retry"
                  className="inline-flex min-h-[28px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
                  onClick={() => { void catalog.sync(true) }}
                >
                  {t('homeApps.actions.tryAgain')}
                </button>
              </div>
            )}
            {catalogPhase === 'no-space' && (
              <div
                className="mt-[12px] rounded-[13px] border border-danger/25 bg-danger/8 px-4 py-3 text-xs text-danger"
                data-testid="circle-content-no-space"
              >
                {t('homeApps.errors.unavailable')}
              </div>
            )}
            {directoryRejected && (
              <div
                className="mt-[12px] rounded-[13px] border border-danger/25 bg-danger/8 px-4 py-3 text-xs text-danger"
                data-testid="circle-content-rejected"
              >
                <p className="m-0 font-medium">{t('poo70.h3.home.rejectedTitle')}</p>
                <p className="m-0 mt-[2px]">{t('poo70.h3.home.rejectedHint')}</p>
              </div>
            )}
            {directoryVerifiable && rows.length === 0 && appClassEntitlements === 0 && (
              <p
                className="m-0 mt-[10px] text-[12px] leading-[1.5] text-muted-foreground"
                data-testid="circle-content-apps-empty"
              >
                {t('poo70.c4.content.appsEmpty')}
              </p>
            )}
            {appsUnverified && (
              <div
                className="mt-[12px] rounded-[13px] border border-info/25 bg-info/8 px-4 py-3 text-xs text-info-text"
                data-testid="circle-content-apps-partial"
              >
                {t('poo70.c4.content.appsUnverified')}
              </div>
            )}

            {directoryVerifiable && rows.length > 0 && (
              <div className="mt-[14px] grid grid-cols-1 gap-[16px] min-[761px]:grid-cols-2 min-[1081px]:grid-cols-3">
                {rows.map(row => {
                  const reason = circleAppRowUnavailableReason(row)
                  const version = row.entry.app.catalogVersion?.version ?? null
                  return (
                    <div
                      key={row.entry.identityKey}
                      data-testid={`circle-content-app-${row.entry.identityKey}`}
                      data-catalog-entry-id={row.entry.catalogEntryId}
                      data-artifact-instance-id={row.entry.artifactInstanceId ?? ''}
                      data-stable-version={version ?? ''}
                      data-launch-blocked={row.entry.launchBlocked ? 'true' : 'false'}
                    >
                      <MemberAppCard
                        variant="detail"
                        app={row.entry.app}
                        identityKey={row.entry.identityKey}
                        testId="circle-content-app-card"
                        onOpen={() => handleOpenApp(row)}
                      />
                      {/* P70-CIRCLE-CONTENT-01: the detail view keeps the
                      stable version and, for blocked rows, the concrete
                      unavailability reason (§13.11: reasons get an explicit
                      explanation, never a silent dead card). */}
                      {(version !== null || reason !== null) && (
                        <p
                          className="m-0 mt-[6px] px-[2px] text-[11px] leading-[1.5] text-muted-foreground"
                          data-testid={`circle-content-app-reason-${row.entry.identityKey}`}
                          data-reason={reason ?? ''}
                        >
                          {version !== null && (
                            <span>{t('poo70.c4.content.versionValue', { version })}</span>
                          )}
                          {version !== null && reason !== null && ' · '}
                          {reason === 'circle_source_lost' && t('poo70.c4.content.sourceLost')}
                          {reason === 'withdrawn' && t('poo70.c4.content.unavailableReasonWithdrawn')}
                          {reason === 'authorization_ended' && t('poo70.c4.content.unavailableReasonAuthorizationEnded')}
                          {reason === 'space_restricted' && t('poo70.c4.content.unavailableReasonSpaceRestricted')}
                          {reason === 'version_unavailable' && t('poo70.c4.content.unavailableReasonVersionUnavailable')}
                          {reason === 'version_blocked' && t('poo70.c4.content.unavailableReasonVersionBlocked')}
                          {reason === 'generic' && t('poo70.c4.content.unavailableReasonGeneric')}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* ── 技能 (read-only this batch) ──────────────────────────── */}
          {skills.length > 0 && (
            <section className="mt-[28px]" data-testid="circle-content-skills-section">
              <h2 className="m-0 text-[16px] font-bold tracking-[-0.01em]">
                {t('poo70.c4.content.skillsTitle')}
              </h2>
              <div className="mt-[14px]">
                <CircleSkillSummary skills={skills} />
              </div>
            </section>
          )}
        </>
      )}

      {/* The shared prepare (install/update) confirmation, same keys and
      flow as the home dialog: part of the REUSED open action, not a new
      capability. */}
      <Dialog open={Boolean(memberActions.prepareTarget)} onOpenChange={(open) => {
        if (!open) memberActions.cancelPrepare()
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {prepareTargetApp && catalog.getInstallState(prepareTargetApp)?.state === 'installed'
                ? t('homeApps.install.updateTitle', {
                    name: prepareTargetApp.name,
                  })
                : t('homeApps.install.installTitle', {
                    name: prepareTargetApp?.name ?? t('homeApps.appFallback'),
                  })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.install.description')}
            </DialogDescription>
          </DialogHeader>
          {prepareTargetApp && memberActions.prepareTarget && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-foreground/4 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.version')}
                  </p>
                  <p className="mt-1 font-medium">{memberActions.prepareTarget.launch.subject.version}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.downloadSize')}
                  </p>
                  <p className="mt-1 font-medium">
                    {formatBytes(t, memberActions.prepareTarget.launch.delivery.sizeBytes)}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('homeApps.install.permissions')}
                </p>
                {prepareTargetApp.permissions?.length ? (
                  <ul className="mt-2 space-y-1.5">
                    {prepareTargetApp.permissions.map(permission => (
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
            <Button type="button" variant="secondary" onClick={() => memberActions.cancelPrepare()}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={() => { void memberActions.confirmPrepare() }}>
              {prepareTargetApp && catalog.getInstallState(prepareTargetApp)?.state === 'installed'
                ? t('homeApps.actions.update')
                : t('homeApps.actions.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
