import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { MemberCircleSnapshot, MemberMembership } from '@polo-ai/shared/admin'
import { useOptionalClientPage } from '@/context/ClientPageContext'
import type { ClientCircleDetailSection } from '@/context/ClientPageContext'
import { useMemberCatalog } from '@/context/MemberCatalogContext'
import { useMemberCircles } from '@/context/MemberCircleResourceContext'
import type { MemberCirclesReadPhase } from '@/hooks/useMemberCircles'
import { useLeaveCircle } from '@/hooks/useLeaveCircle'
import { useProductSpaceAppLaunchHandoff } from '@/context/ProductSpaceContext'
import {
  selectHomeAppDirectory,
  type HomeAppDirectory,
} from '@/lib/home-app-directory'
import { selectLatestEntitlementJudgment } from '@/lib/member-circle-view'
import { CircleContentPanel } from './CircleContentPanel'
import { CircleSubscriptionPanel } from './CircleSubscriptionPanel'
import { CircleSupportPanel, type CircleSupportTarget } from './CircleSupportPanel'
import { CircleUpdatesPanel } from './CircleUpdatesPanel'
import { LeaveCircleDialog } from './LeaveCircleDialog'

/**
 * Circle detail page (POO-70 C9 / POO-100; P70-CIRCLE-DETAIL-01/02/03).
 *
 * The ASSEMBLY card: this page mounts the already-integrated contracts —
 * C4 content panel, C5 updates panel, C6 subscription panel, C7 leave flow,
 * S1 support panel — for ONE circle under the N1 `circle-detail` route, and
 * owns nothing those cards already own:
 *
 * - Identity (P70-CIRCLE-DETAIL-01): the heading renders the SAME C2 row the
 *   list rendered (`resource.getCircle(circleId)`) — one circle identity, no
 *   second data source. The section titles are NOT duplicated here: C4 owns
 *   应用/技能, C5 owns 内容更新, C6 owns 订阅; the tab row below the heading is
 *   ROUTE navigation (N1 section field), rendered verbatim from the prototype
 *   `.r14-tabs` (内容 / 更新 / 订阅).
 *
 * - Read authority (P70-CIRCLE-DETAIL-02): every fact comes from the shared
 *   C2 resource + the App-level H1 catalog (via `useMemberCatalog`) — the
 *   same instances the home and list pages read, so a refresh after
 *   exit/return keeps list, detail and 我的应用 consistent. The page never
 *   renders another member's data: `unknown_circle` (this scope's rows do
 *   not contain the id) renders waiting/error/denied/exited states keyed off
 *   the C2 relations phase, never a guessed profile.
 *
 * - Exit (P70-CIRCLE-DETAIL-02, 退出仅订阅区): the leave entry renders ONLY
 *   in the subscription section; C7 (`useLeaveCircle` + `LeaveCircleDialog`)
 *   owns the flow. `lastSourceWorkNames` is computed HERE from the H1
 *   projection (`selectCircleLastSourceWorkNames`): works that would lose
 *   their LAST valid authorization source. After a confirmed leave the page
 *   keeps the CORRECT object (the F1 receipt keeps an expired relation in
 *   C2) and surfaces the honest outcome + read-only re-verify; navigation
 *   stays on this page (the C2 receipt now shows the restore state).
 *
 * - Recovery: every failure state keeps its own explicit retry (C2 refresh
 *   for relations, C2 refreshUpdates for the updates read, the panels'
 *   built-in retries); S1 (`CircleSupportPanel`) mounts as a LOCAL recovery
 *   view over the original circle-read exception — the original state stays
 *   rendered behind it, closing S1 returns to it, and its manual re-check
 *   runs the C2 `invalidateAndRefresh` (authoritative relations + shared
 *   catalog re-verification; the C8 `checkOnce` wiring is upstream-expected
 *   while POO-99 is not yet integrated into the line).
 *
 * - Shell reachability (P70-CIRCLE-DETAIL-03): the page renders inside the
 *   real TabContent home branch via ClientHomeRouter; the route can only be
 *   produced by the circles list navigation (N1 stack) or an in-scope
 *   section switch — there is no deep link that fabricates a circle route,
 *   and an enterprise/denied C2 scope renders the denied state (C2 refuses
 *   the scope before any row exists). The root element is the page's MAIN
 *   scroller; ClientHomeRouter registers it with N1 `registerMainScroller`
 *   so scrolling THIS page drives the header hairline. No skills-management
 *   surface and no assistant implementation change exists here.
 *
 * Upstream-expected (not blocking this assembly): C8/POO-99
 * (`useCircleReturn` + `CircleReturnPanel`) is still in review on its own
 * branch — the return-verification consumption (B1 typed events, candidate
 * region) mounts into this page when its integration lands; no stub is
 * faked here.
 */

// ---------------------------------------------------------------------------
// Pure projections (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Works that would lose their LAST valid authorization source if THIS
 * circle's source were revoked (the C7 dialog's `lastSourceWorkNames` fact,
 * computed from the H1 projection as the C7 handoff requires). An entry
 * qualifies only when it HAS a valid creator_circle source of THIS circle
 * AND no other valid source beside it. The directory phase is the caller's
 * concern: with a non-verifiable directory this returns [] and the dialog
 * falls back to the generic per-source wording (never a fabricated list).
 */
export function selectCircleLastSourceWorkNames(
  directory: Pick<HomeAppDirectory, 'entries'>,
  circleId: string,
): string[] {
  if (!circleId) return []
  const names: string[] = []
  for (const entry of directory.entries) {
    const thisSource = entry.sources.find(
      source => source.kind === 'creator_circle' && source.circleId === circleId,
    )
    if (!thisSource || !thisSource.valid) continue
    const hasOtherValidSource = entry.sources.some(
      source => source !== thisSource && source.valid,
    )
    if (!hasOtherValidSource) names.push(entry.app.name)
  }
  return names
}

export interface CircleDetailHeadingState {
  /** Effective lifecycle: the membership row wins, the circle row falls back. */
  status: MemberMembership['status'] | MemberCircleSnapshot['status']
  /** True when the entitlement is restricted (lifecycle or G5 projection). */
  restricted: boolean
  appsCount: number
  skillsCount: number
}

/**
 * Heading facts from the SAME authoritative rows (the C3 row rule, applied
 * to the detail heading): lifecycle first, then the correction-aware payment
 * projection (G5) — a stored `paid` order alone never reads as valid.
 */
export function deriveCircleDetailHeadingState(
  circle: MemberCircleSnapshot,
  membership: MemberMembership | null,
): CircleDetailHeadingState {
  const status = membership?.status ?? circle.status
  const judgment = membership ? selectLatestEntitlementJudgment(membership) : null
  const projectedNotPaid = judgment !== null
    && judgment.basis === 'projected'
    && judgment.effectivePaymentStatus !== 'paid'
  return {
    status,
    restricted: status !== 'active' || projectedNotPaid,
    appsCount: circle.entitlements.filter(e => e.artifact.type === 'web_app').length,
    skillsCount: circle.entitlements.filter(e => e.artifact.type === 'skill').length,
  }
}

/** The section switch order (prototype `.r14-tabs`: 内容 / 更新 / 订阅). */
const DETAIL_SECTIONS: readonly ClientCircleDetailSection[] = ['content', 'updates', 'subscription']

function sectionTabKey(section: ClientCircleDetailSection): string {
  return section === 'content'
    ? 'poo70.c9.tab.content'
    : section === 'updates'
      ? 'poo70.c9.tab.updates'
      : 'poo70.c9.tab.subscription'
}

// ---------------------------------------------------------------------------
// Page-level unknown-circle state (updates/subscription sections; the content
// section mounts C4, which renders its own phase-keyed states)
// ---------------------------------------------------------------------------

function CircleUnavailableState({
  phase,
  onRetry,
}: {
  phase: MemberCirclesReadPhase
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  if (phase === 'loading') {
    return (
      <div
        className="mt-[16px] flex items-center gap-[8px] rounded-[13px] border border-border px-4 py-3 text-xs text-muted-foreground"
        data-testid="circle-detail-unavailable-loading"
      >
        <Icons.LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        {t('poo70.c4.content.relationsLoading')}
      </div>
    )
  }
  if (phase === 'idle') {
    return (
      <div
        className="mt-[16px] rounded-[13px] border border-border bg-surface px-4 py-3 text-xs text-muted-foreground"
        data-testid="circle-detail-unavailable-idle"
      >
        {t('poo70.c3.state.idle')}
      </div>
    )
  }
  if (phase === 'denied') {
    return (
      <div
        className="mt-[16px] rounded-[13px] border border-danger/25 bg-danger/8 px-4 py-3 text-xs text-danger"
        data-testid="circle-detail-unavailable-denied"
      >
        {t('homeApps.organization.accessError')}
      </div>
    )
  }
  if (phase === 'error' || phase === 'offline' || phase === 'partial') {
    const copy = phase === 'error'
      ? t('poo70.c4.content.relationsError')
      : phase === 'offline'
        ? t('poo70.c4.content.relationsOffline')
        : t('poo70.c4.content.relationsPartial')
    return (
      <div
        className={
          phase === 'error'
            ? 'mt-[16px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-danger/25 bg-danger/8 px-4 py-3 text-xs text-danger'
            : 'mt-[16px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text'
        }
        data-testid={`circle-detail-unavailable-${phase}`}
      >
        <span>{copy}</span>
        {onRetry && (
          <button
            type="button"
            data-testid="circle-detail-unavailable-retry"
            className="inline-flex min-h-[28px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            onClick={onRetry}
          >
            {t('homeApps.actions.tryAgain')}
          </button>
        )}
      </div>
    )
  }
  // Settled relations (ready / empty): the circleId is absent from THIS
  // scope's authoritative rows — the exited fact, same wording as C4.
  return (
    <div
      className="mt-[16px] grid justify-items-center gap-[10px] rounded-[20px] border border-dashed border-border px-[20px] py-[34px] text-center"
      data-testid="circle-detail-unavailable-exited"
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

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export interface CircleDetailPageProps {
  /** The STABLE circleId carried by the N1 `circle-detail` route. */
  circleId: string
  /** The active detail section (N1 route field; the tabs navigate it). */
  section: ClientCircleDetailSection
}

export function CircleDetailPage({ circleId, section }: CircleDetailPageProps) {
  const { t } = useTranslation()
  const resource = useMemberCircles()
  const clientPage = useOptionalClientPage()
  const catalog = useMemberCatalog()
  const launchHandoff = useProductSpaceAppLaunchHandoff()
  const leave = useLeaveCircle()

  const detail = resource.getCircle(circleId)
  const relationsPhase = resource.state.phase

  // ── H1 projection (the SAME directory instances the home consumes) ────────
  const activeProductSpace = catalog.productSpace?.activeProductSpace
  const spaceKind = activeProductSpace?.kind ?? null
  const directory = useMemo<HomeAppDirectory>(
    () => selectHomeAppDirectory(catalog.state.catalog, {
      accountId: catalog.productSpace?.accountId ?? null,
      productSpaceId: catalog.productSpace?.activeProductSpaceId ?? null,
      spaceKind,
      loading: catalog.state.loading,
      errorCode: catalog.state.errorCode,
      accessMode: catalog.state.accessMode,
    }),
    [
      catalog.productSpace?.accountId,
      catalog.productSpace?.activeProductSpaceId,
      catalog.state.accessMode,
      catalog.state.catalog,
      catalog.state.errorCode,
      catalog.state.loading,
      spaceKind,
    ],
  )

  // ── C5 updates read: C9 ISSUES it (the panel is a pure projection) ────────
  // One authoritative read per (circle, section entry) while no receipt
  // exists; a failed read recovers through the panel's explicit retry only.
  const updatesRead = resource.updateStates[circleId] ?? null
  useEffect(() => {
    if (section !== 'updates') return
    if (detail.availability !== 'ready') return
    if (updatesRead) return
    void resource.getUpdates(circleId)
  }, [section, detail.availability, updatesRead, circleId, resource])

  // ── Route navigation (N1): section switch + back ──────────────────────────
  const handleSectionChange = useCallback((next: ClientCircleDetailSection) => {
    // Navigating to the current route is a no-op inside the N1 reducer.
    clientPage?.navigate({ kind: 'circle-detail', circleId, section: next })
  }, [clientPage, circleId])

  const handleBack = useCallback(() => {
    if (!clientPage) return
    if (clientPage.canGoBack) {
      clientPage.back()
    } else {
      clientPage.navigate({ kind: 'circles' })
    }
  }, [clientPage])

  // ── C7 leave flow (subscription section only) ─────────────────────────────
  const circleReady = detail.availability === 'ready'
  const circleSnapshot = circleReady ? detail.circle : null
  const membership = circleReady ? detail.membership : null
  // The leave entry exists only for an ACTIVE membership — the only state F1
  // allows to leave (suspended answers 409 by contract; expired IS "left").
  // No dead button: suspended shows C6's reason banner, expired the restore
  // renewal entry.
  const canRequestLeave = circleReady
    && membership !== null
    && (membership.status ?? circleSnapshot!.status) === 'active'

  const lastSourceWorkNames = useMemo(
    () => (circleReady ? selectCircleLastSourceWorkNames(directory, circleId) : []),
    [circleReady, directory, circleId],
  )

  const handleRequestLeave = useCallback(() => {
    if (!circleReady || !membership || !circleSnapshot) return
    leave.request({
      circleId,
      membershipId: membership.membershipId,
      circleName: circleSnapshot.circle.name,
      lastSourceWorkNames,
    })
  }, [circleReady, membership, circleSnapshot, leave, circleId, lastSourceWorkNames])

  // ── S1 local recovery view (original circle-read exception) ───────────────
  // The help entry appears only when THIS circle's read itself failed
  // (relations error/offline — the id cannot be verified against the
  // authoritative rows). The original exception state stays rendered; S1 is
  // an additional local view, closing it returns to the original exception.
  const [supportOpen, setSupportOpen] = useState(false)
  useEffect(() => {
    // A different circle (or route) starts clean: no stale help view.
    setSupportOpen(false)
  }, [circleId, section])
  const circleReadFailed = detail.availability === 'unknown_circle'
    && (relationsPhase === 'error' || relationsPhase === 'offline')
  const supportTarget = useMemo<CircleSupportTarget | null>(() => {
    if (!circleReadFailed) return null
    return {
      kind: 'circle',
      circleId,
      orderId: null,
      circleName: null,
      issueSummary: relationsPhase === 'offline'
        ? t('poo70.c4.content.relationsOffline')
        : t('poo70.c4.content.relationsError'),
    }
  }, [circleReadFailed, circleId, relationsPhase, t])

  // Manual re-check of the original object: the C2 authoritative re-read +
  // shared-catalog refresh. (C8 `checkOnce` wiring is upstream-expected —
  // POO-99 is not integrated into the line yet; this is the read-only
  // re-verification that EXISTS today, never a fabricated verdict.)
  const handleSupportRecheck = useCallback(() => {
    void resource.invalidateAndRefresh({ circleId })
  }, [resource, circleId])

  const relationsRetry = useCallback(() => {
    void resource.refresh()
  }, [resource])

  // ── Heading facts (ready circles only; unknown renders no identity) ───────
  const heading = circleReady
    ? deriveCircleDetailHeadingState(detail.circle, detail.membership)
    : null
  const countsLine = useMemo(() => {
    if (!heading) return ''
    const parts: string[] = []
    if (heading.appsCount > 0) parts.push(t('poo70.c3.count.apps', { count: heading.appsCount }))
    if (heading.skillsCount > 0) parts.push(t('poo70.c3.count.skills', { count: heading.skillsCount }))
    return parts.length > 0 ? parts.join(' · ') : t('poo70.c3.count.none')
  }, [heading, t])
  const termText = useMemo(() => {
    if (!heading || !circleReady) return ''
    const membershipRow = detail.membership
    const billingKind = membershipRow?.billingKind ?? detail.circle.billingKind
    const currentPeriodEnd = membershipRow?.currentPeriodEnd ?? detail.circle.currentPeriodEnd
    if (heading.restricted) return t('poo70.c3.entitlement.restore')
    if (billingKind === 'free') return t('poo70.c3.entitlement.free')
    const parsed = currentPeriodEnd ? Date.parse(currentPeriodEnd) : Number.NaN
    if (!Number.isFinite(parsed)) return t('poo70.c3.entitlement.paidNoDate')
    return t('poo70.c3.entitlement.paidToDate', {
      date: new Date(parsed).toISOString().slice(0, 10),
    })
  }, [heading, circleReady, detail])

  return (
    // The page's MAIN scroller — ClientHomeRouter registers THIS element with
    // the N1 header-line controller (P70-CIRCLE-DETAIL-03).
    <div
      className="h-full min-h-0 overflow-y-auto"
      data-testid="circle-detail-page"
      data-circle-id={circleId}
      data-section={section}
    >
      <main
        className="mx-auto w-full max-w-[1260px] bg-background px-[18px] pb-[50px] pt-[30px] text-[16px] text-foreground min-[761px]:px-[26px] min-[761px]:pb-[58px] min-[761px]:pt-[36px] min-[1081px]:px-[44px] min-[1081px]:pb-[72px] min-[1081px]:pt-[46px]"
      >
        {/* Prototype `.subpage-heading.circle-detail-heading`: back button +
        eyebrow + THE single identity heading (ready circles only). */}
        <div className="flex flex-col gap-[16px]">
          <button
            type="button"
            data-testid="circle-detail-back"
            onClick={handleBack}
            className="inline-flex min-h-[32px] w-fit items-center gap-[6px] rounded-[8px] border-0 bg-transparent px-[8px] text-[13px] font-medium text-foreground-60 hover:bg-foreground-5 hover:text-foreground"
          >
            {t('poo70.c9.page.back')}
          </button>
          <div className="flex flex-wrap items-end justify-between gap-[16px]">
            <div>
              <p className="m-0 text-[12px] font-medium uppercase tracking-[0.04em] text-foreground-50">
                {t('poo70.c9.page.eyebrow')}
              </p>
              {circleReady && (
                <>
                  <h1
                    data-testid="circle-detail-title"
                    className="m-0 mt-[6px] text-[30px] font-bold leading-[1.08] tracking-[-0.055em] min-[761px]:text-[36px]"
                  >
                    {detail.circle.circle.name}
                  </h1>
                  <p
                    className="m-0 mt-[10px] text-[15px] leading-[1.65] text-muted-foreground"
                    data-testid="circle-detail-meta"
                  >
                    {countsLine}
                  </p>
                </>
              )}
            </div>
            {heading && (
              <div
                className="flex items-center gap-[10px]"
                data-testid="circle-detail-heading-status"
                data-status={heading.restricted ? 'restore' : 'valid'}
              >
                <span
                  className={`inline-flex min-h-[24px] items-center rounded-full px-[10px] text-[12px] font-medium ${
                    heading.restricted
                      ? 'bg-foreground/6 text-muted-foreground'
                      : 'bg-success/10 text-success-text'
                  }`}
                  data-testid="circle-detail-status"
                >
                  {heading.restricted
                    ? t('poo70.c3.entitlement.restore')
                    : t('poo70.c3.filter.valid')}
                </span>
                {termText !== '' && (
                  <small className="text-[12px] text-muted-foreground" data-testid="circle-detail-term">
                    {termText}
                  </small>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Prototype `.r14-tabs`: ROUTE navigation — the panels below own the
        section titles (分区不造第二套标题). */}
        <nav
          aria-label={t('poo70.c9.tabs.label')}
          className="mt-[24px] flex flex-wrap gap-[8px]"
          data-testid="circle-detail-tabs"
        >
          {DETAIL_SECTIONS.map(entry => (
            <button
              key={entry}
              type="button"
              data-testid={`circle-detail-tab-${entry}`}
              aria-current={section === entry ? 'page' : undefined}
              onClick={() => handleSectionChange(entry)}
              className={
                section === entry
                  ? 'inline-flex min-h-[32px] items-center justify-center rounded-[8px] bg-foreground px-[14px] text-[13px] font-medium text-background'
                  : 'inline-flex min-h-[32px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[14px] text-[13px] font-medium text-foreground hover:bg-foreground-5'
              }
            >
              {t(sectionTabKey(entry))}
            </button>
          ))}
        </nav>

        {/* S1 help entry: only over the ORIGINAL circle-read exception. The
        panel below stays rendered (closing S1 returns to it unchanged). */}
        {circleReadFailed && !supportOpen && (
          <div className="mt-[20px]">
            <button
              type="button"
              data-testid="circle-detail-support-entry"
              onClick={() => setSupportOpen(true)}
              className="inline-flex min-h-[30px] items-center gap-[6px] rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            >
              <Icons.LifeBuoy className="size-[14px]" aria-hidden="true" />
              {t('poo70.c9.support.entry')}
            </button>
          </div>
        )}

        {/* S1 local recovery view (circle-read exception): rendered as an
        ADDITIONAL panel above the section body; the original exception state
        below stays untouched, closing returns to it (P70-SUPPORT-03). */}
        {supportOpen && supportTarget && (
          <CircleSupportPanel
            target={supportTarget}
            onBack={() => setSupportOpen(false)}
            onRecheck={handleSupportRecheck}
          />
        )}

        {/* ── Section body ────────────────────────────────────────────────── */}
        {section === 'content' && (
          <CircleContentPanel
            circle={detail}
            context={{
              directory,
              catalog,
              spaceKind,
              launchHandoff,
              relationsPhase,
              onRefreshRelations: relationsRetry,
            }}
          />
        )}
        {section === 'updates' && (
          circleReady ? (
            <CircleUpdatesPanel
              circleId={circleId}
              updates={updatesRead?.phase === 'ready' ? updatesRead.state : null}
              state={updatesRead ?? undefined}
              onRetry={() => void resource.refreshUpdates(circleId)}
            />
          ) : (
            <CircleUnavailableState phase={relationsPhase} onRetry={relationsRetry} />
          )
        )}
        {section === 'subscription' && (
          circleReady ? (
            <>
              <CircleSubscriptionPanel
                circle={detail.circle}
                membership={detail.membership}
                onLeave={handleRequestLeave}
              />
              {/* The ONLY exit entry (退出仅订阅区): C7 owns the flow; the
              button requests THE single confirmation. C6's reserved
              exit-region marker stays untouched inside the panel. */}
              {canRequestLeave && (
                <div className="mt-[14px] border-t border-border pt-[14px]">
                  <button
                    type="button"
                    data-testid="circle-detail-exit"
                    onClick={handleRequestLeave}
                    className="inline-flex min-h-[32px] items-center justify-center rounded-[8px] border border-destructive bg-transparent px-[14px] text-[13px] font-medium text-destructive hover:bg-destructive/8"
                  >
                    {t('poo70.c9.exit.button')}
                  </button>
                </div>
              )}
              {/* Post-leave outcome (C7 receipt): the page keeps the CORRECT
              object — the C2 receipt now reports the expired relation and the
              panel switches to its restore state on its own. */}
              {leave.state.outcome?.kind === 'left' && (
                <div
                  className="mt-[14px] rounded-[13px] border border-border bg-surface px-4 py-3 text-xs"
                  data-testid="circle-detail-leave-outcome"
                  data-verification={leave.state.outcome.verification}
                >
                  <p className="m-0 font-medium text-foreground">
                    {t('poo70.c7.result.leftTitle', {
                      name: leave.state.outcome.circleId === circleId && circleSnapshot
                        ? circleSnapshot.circle.name
                        : leave.state.outcome.circleId,
                    })}
                  </p>
                  <p className="m-0 mt-[4px] text-muted-foreground">
                    {t('poo70.c7.result.leftBody')}
                  </p>
                  {leave.state.outcome.verification === 'pending-recheck' && (
                    <p className="m-0 mt-[4px] text-info-text" data-testid="circle-detail-leave-recheck-pending">
                      {t('poo70.c7.result.recheckPending')}
                    </p>
                  )}
                  <p className="m-0 mt-[4px] text-muted-foreground">
                    {t('poo70.c7.result.rejoinHint')}
                  </p>
                  <button
                    type="button"
                    data-testid="circle-detail-leave-reverify"
                    disabled={leave.state.reverifying}
                    onClick={leave.reverify}
                    className="mt-[10px] inline-flex min-h-[28px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('poo70.c7.result.reverify')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <CircleUnavailableState phase={relationsPhase} onRetry={relationsRetry} />
          )
        )}
      </main>

      {/* C7's THE single confirmation — rendered from the page so the flow
      survives section switches while the dialog is open; the hook refuses
      cancel-while-writing. */}
      <LeaveCircleDialog
        state={leave.state.dialog}
        onConfirm={leave.confirm}
        onCancel={leave.cancel}
      />
    </div>
  )
}
