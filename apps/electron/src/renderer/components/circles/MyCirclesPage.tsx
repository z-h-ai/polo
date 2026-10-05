import { useClientWorkbenchStyle, clientWorkbenchFocusClassName } from '@/components/ui/client-workbench'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemberCircleSnapshot, MemberMembership } from '@polo-ai/shared/admin'
import { useMemberCircles } from '@/context/MemberCircleResourceContext'
import type { MemberCircleScopeKey } from '@/hooks/useMemberCircles'
import { useOptionalClientPage } from '@/context/ClientPageContext'
import {
  memberCircleCreatorNameField,
  selectLatestEntitlementJudgment,
} from '@/lib/member-circle-view'
import {
  MemberCircleRow,
  type MemberCircleAvatarTone,
  type MemberCircleEntitlementState,
  type MemberCircleRowModel,
} from './MemberCircleRow'

/**
 * POO-70 C3 (P70-CIRCLE-LIST-01/02/03) — the 我的圈子 page: ONE page title
 * (我的圈子 ＋ 查看圈子内容，管理订阅, Spec §13.12), search / entitlement
 * filter / the unified circle list beneath it.
 *
 * Read authority: this page CONSUMES the shared C2 resource
 * (`useMemberCircles`) — it never creates its own relations instance and
 * never treats a row as authorization. Provider mounting (outside the page)
 * belongs to C9/POO-100; isolated tests inject or mount the real provider
 * (MemberCircleResourceContext.isolated.ts pattern).
 *
 * State feedback (P70-CIRCLE-LIST-02) — every shape renders DISTINCTLY:
 * loading / empty relations (a legitimate success, with the browser-join
 * guidance but NO share-link input, NO join button, NO marketplace) /
 * search-no-match / error+retry / offline+retry / restricted (denied space or
 * per-row 待恢复) / partial (one receipt failed) / stale (refresh failed over
 * retained rows — rows stay, banner explains, retry is explicit). Nothing
 * auto-executes and no failure is faked into empty.
 *
 * Navigation (P70-CIRCLE-LIST-03): a row hands the STABLE circleId to
 * `clientPage.navigate({ kind: 'circle-detail', circleId, section: 'content' })`.
 * Mounted without the App's ClientPageProvider (isolated probes) the click is
 * a recorded no-op — it never pretends to navigate.
 *
 * Toolbar restore (P70-CIRCLE-LIST-03): the search/filter state is saved per
 * C2 scope fence (accountId + personalProductSpaceId + epoch, in-memory) and
 * restored when the SAME account+space scope returns; another account's (or a
 * re-bound scope's) preferences are never shown.
 */

// ---------------------------------------------------------------------------
// Entitlement filter axis
// ---------------------------------------------------------------------------

export type MyCirclesEntitlementFilter = 'all' | 'valid' | 'restore'

export function filterMemberCircleRows(
  rows: ReadonlyArray<MemberCircleRowModel>,
  filter: MyCirclesEntitlementFilter,
): Array<MemberCircleRowModel> {
  if (filter === 'all') return [...rows]
  return rows.filter(row => row.entitlementState === filter)
}

/**
 * Search over CONFIRMED fields only: circle name and purpose. The creator
 * display name is G1 `upstream_pending` — promising creator-name search would
 * fabricate a capability the trusted receipts do not have, so the creator
 * line is NOT searchable (and never matches on the raw ownerUserId uuid).
 */
export function searchMemberCircleRows(
  rows: ReadonlyArray<MemberCircleRowModel>,
  normalizedQuery: string,
): Array<MemberCircleRowModel> {
  if (!normalizedQuery) return [...rows]
  return rows.filter(row =>
    row.name.toLocaleLowerCase().includes(normalizedQuery)
    || (row.summary ?? '').toLocaleLowerCase().includes(normalizedQuery))
}

// ---------------------------------------------------------------------------
// Date rendering (deterministic UTC calendar date of the provider instant)
// ---------------------------------------------------------------------------

/**
 * Renders a provider ISO instant as its calendar date (YYYY-MM-DD), the same
 * shape the confirmed UI target uses. The UTC date is deterministic across
 * device time zones — a display choice, never an entitlement judgment.
 */
export function formatPeriodDate(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return ''
  return new Date(parsed).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Row normalization (交接接口: CircleRow 接受规范化 model)
// ---------------------------------------------------------------------------

/** First grapheme of a string, surrogate-pair safe; '?' when there is none. */
function firstGrapheme(value: string): string {
  const first = Array.from(value.trim())[0]
  return first ?? '?'
}

/** Translator contract (the React i18next `t` satisfies it). */
export type MyCirclesTranslate = (key: string, options?: Record<string, unknown>) => string

/**
 * Builds ONE normalized row model from the authoritative receipts. The
 * circles receipt is the list surface; the membership row (same circleId)
 * enriches lifecycle/payment facts. The entitlement state is 'restore' when
 * the provider lifecycle says suspended/expired OR the correction-aware
 * payment projection (G5, judgeMembershipPaymentStatus family) says the
 * latest order is no longer paid. An UNKNOWN projection (no orders /
 * projection missing) is a fact, not a failure — lifecycle stays the
 * authority and the row is NOT downgraded.
 */
export function normalizeMemberCircleRow(
  circle: MemberCircleSnapshot,
  memberships: ReadonlyArray<MemberMembership>,
  translate: MyCirclesTranslate,
): MemberCircleRowModel {
  const circleId = circle.circle.circleId
  const membership = memberships.find(
    candidate => candidate.circle.circleId === circleId,
  ) ?? null
  const status = membership?.status ?? circle.status
  const billingKind = membership?.billingKind ?? circle.billingKind
  const currentPeriodEnd = membership?.currentPeriodEnd ?? circle.currentPeriodEnd
  const judgment = membership ? selectLatestEntitlementJudgment(membership) : null
  const projectedNotPaid = judgment !== null
    && judgment.basis === 'projected'
    && judgment.effectivePaymentStatus !== 'paid'
  const restricted = status !== 'active' || projectedNotPaid
  const entitlementState: MemberCircleEntitlementState = restricted ? 'restore' : 'valid'

  let termText: string
  if (restricted) {
    termText = translate('poo70.c3.entitlement.restore')
  } else if (billingKind === 'free') {
    termText = translate('poo70.c3.entitlement.free')
  } else {
    const date = currentPeriodEnd ? formatPeriodDate(currentPeriodEnd) : ''
    termText = date
      ? translate('poo70.c3.entitlement.paidToDate', { date })
      : translate('poo70.c3.entitlement.paidNoDate')
  }

  return {
    circleId,
    membershipId: membership?.membershipId ?? null,
    name: circle.circle.name,
    avatarChar: firstGrapheme(circle.circle.name),
    avatarTone: restricted
      ? 'restricted' as MemberCircleAvatarTone
      : billingKind === 'free'
        ? 'free' as MemberCircleAvatarTone
        : 'paid' as MemberCircleAvatarTone,
    creatorName: memberCircleCreatorNameField(circle.circle),
    summary: circle.circle.purpose.trim() ? circle.circle.purpose : null,
    termText,
    entitlementState,
    appsCount: circle.entitlements.filter(e => e.artifact.type === 'web_app').length,
    skillsCount: circle.entitlements.filter(e => e.artifact.type === 'skill').length,
  }
}

// ---------------------------------------------------------------------------
// Per-account toolbar preferences (in-memory, scope-fenced)
// ---------------------------------------------------------------------------

export interface MyCirclesViewPreferences {
  query: string
  filter: MyCirclesEntitlementFilter
}

const VIEW_PREFERENCES_VERSION = 1

/**
 * In-memory store keyed by the C2 scope fence. The same live scope restores
 * its toolbar state when the user returns from circle detail; any scope
 * rebind (other account, committed space switch, epoch bump) keys a fresh
 * entry — another account's filters can never surface (P70-CIRCLE-LIST-03).
 */
const viewPreferencesByScope = new Map<string, MyCirclesViewPreferences>()

export function myCirclesViewPreferencesKey(scope: MemberCircleScopeKey): string {
  return JSON.stringify([
    'poo70-c3-view',
    VIEW_PREFERENCES_VERSION,
    scope.accountId,
    scope.personalProductSpaceId,
    scope.epoch,
  ])
}

export function loadMyCirclesViewPreferences(
  key: string | null,
): MyCirclesViewPreferences | null {
  if (!key) return null
  return viewPreferencesByScope.get(key) ?? null
}

export function saveMyCirclesViewPreferences(
  key: string | null,
  preferences: MyCirclesViewPreferences,
): void {
  if (!key) return
  viewPreferencesByScope.set(key, { ...preferences })
}

/** Test hook: clears the module-level in-memory store. */
export function __resetMyCirclesViewPreferencesForTests(): void {
  viewPreferencesByScope.clear()
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function MyCirclesPage() {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const resource = useMemberCircles()
  const clientPage = useOptionalClientPage()

  const scope = resource.state.scope
  const scopeKey = useMemo(
    () => (scope ? myCirclesViewPreferencesKey(scope) : null),
    [scope],
  )
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<MyCirclesEntitlementFilter>('all')

  // Restore THIS scope's toolbar state when the fence binds or changes; an
  // absent scope (idle/denied) resets to the defaults instead of keeping the
  // previous binding's filters on screen.
  useEffect(() => {
    const preferences = loadMyCirclesViewPreferences(scopeKey)
    setQuery(preferences?.query ?? '')
    setFilter(preferences?.filter ?? 'all')
  }, [scopeKey])

  // Persist on every change so returning from circle-detail (same live scope)
  // restores the exact search/filter combination.
  useEffect(() => {
    saveMyCirclesViewPreferences(scopeKey, { query, filter })
  }, [scopeKey, query, filter])

  const rows = useMemo(
    () => (resource.circles ?? []).map(circle => normalizeMemberCircleRow(circle, resource.memberships ?? [], t)),
    [resource.circles, resource.memberships, t],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleRows = useMemo(
    () => filterMemberCircleRows(
      searchMemberCircleRows(rows, normalizedQuery),
      filter,
    ),
    [rows, normalizedQuery, filter],
  )

  const phase = resource.state.phase
  // The circles receipt is the list surface: whenever it exists its rows may
  // render (even while the memberships receipt half-failed or a refresh
  // failed over the retained cache).
  const rowsAvailable = resource.circles !== null
  const hasReceiptErrors = resource.state.circlesError !== null
    || resource.state.membershipsError !== null
  const showList = rowsAvailable && rows.length > 0
  const searchNoMatch = showList && visibleRows.length === 0

  // Explicit retry — the only recovery path; nothing auto-executes.
  const handleRetry = useCallback(() => {
    void resource.refresh()
  }, [resource])

  // P70-CIRCLE-LIST-03: the STABLE circleId is the only navigation payload.
  // Without the App's ClientPageProvider (isolated probes) this stays a
  // no-op — it never fakes a navigation.
  const handleOpenRow = useCallback((model: MemberCircleRowModel) => {
    clientPage?.navigate({ kind: 'circle-detail', circleId: model.circleId, section: 'content' })
  }, [clientPage])

  const handleBack = useCallback(() => {
    // The route stack root is home; back from circles returns there. Without
    // the provider (isolated probes) the button does nothing — no fake exit.
    if (!clientPage) return
    if (clientPage.canGoBack) {
      clientPage.back()
    } else {
      clientPage.navigate({ kind: 'home' })
    }
  }, [clientPage])

  return (
    // Same scroll ownership as the home surface: the DEDICATED wrapper owns
    // viewport-bounded scrolling; C9 (POO-100) registers the main scroller.
    <div className="h-full min-h-0 overflow-y-auto">
      <main
        style={workbenchStyle}
        className={clientWorkbenchFocusClassName + " mx-auto w-full max-w-[1260px] bg-background px-[18px] pb-[50px] pt-[30px] text-[15px] text-foreground min-[761px]:px-[26px] min-[761px]:pb-[58px] min-[761px]:pt-[36px] min-[1081px]:px-[44px] min-[1081px]:pb-[72px] min-[1081px]:pt-[46px]"}
        data-testid="my-circles-page"
      >
        {/* Prototype `.subpage-heading`: back button + eyebrow + THE single
        page title pair (Spec §13.12 文案去重). */}
        <div className="mb-[18px] flex items-start gap-[18px]">
          <button
            type="button"
            data-testid="my-circles-back"
            onClick={handleBack}
            className="inline-flex min-h-[30px] w-fit shrink-0 items-center gap-[5px] rounded-[6px] border-0 bg-transparent px-[8px] text-[11px] font-medium text-foreground-60 hover:bg-foreground-5 hover:text-foreground"
          >
            {t('poo70.c3.page.back')}
          </button>
          <div className="min-w-0 flex-1">
            <p className="m-0 mb-[7px] text-[11px] font-medium uppercase tracking-[0.75px] text-foreground-50">
              {t('poo70.c3.page.eyebrow')}
            </p>
            <h1
              data-testid="my-circles-title"
              className="m-0 text-[22px] font-bold leading-[1.25] tracking-[-0.03em]"
            >
              {t('poo70.c3.page.title')}
            </h1>
            <p className="m-0 mt-[7px] text-[13px] leading-[1.5] text-foreground-60">
              {t('poo70.c3.page.subtitle')}
            </p>
          </div>
        </div>

        {/* P70-CIRCLE-LIST-02: every system state renders DISTINCTLY. */}

        {phase === 'denied' && (
          <div
            className="mt-[24px] rounded-[13px] border border-destructive/25 bg-destructive/8 px-4 py-3 text-xs text-destructive"
            data-testid="my-circles-restricted-banner"
          >
            {t('poo70.c3.state.denied')}
          </div>
        )}

        {phase === 'idle' && (
          <div
            className="mt-[24px] rounded-[13px] border border-border bg-surface px-4 py-3 text-xs text-muted-foreground"
            data-testid="my-circles-idle-banner"
          >
            {t('poo70.c3.state.idle')}
          </div>
        )}

        {phase === 'loading' && (
          <div
            className="mt-[24px] rounded-[13px] border border-border bg-surface px-4 py-4 text-sm text-muted-foreground"
            data-testid="my-circles-loading"
          >
            {t('poo70.c3.state.loading')}
          </div>
        )}

        {phase === 'empty' && (
          <div
            className="mt-[24px] grid justify-items-center gap-[10px] rounded-[16px] border border-border bg-surface px-[20px] py-[28px] text-center"
            data-testid="my-circles-empty"
          >
            <h2 className="m-0 text-[18px] font-bold text-foreground">{t('poo70.c3.state.emptyTitle')}</h2>
            <p className="m-0 max-w-[440px] text-[13px] leading-[1.6] text-muted-foreground">
              {t('poo70.c3.state.emptyHint')}
            </p>
            {/* Deliberately NO share-link input, NO join button, NO marketplace
            entry (PC-F03: 桌面列表/空态不提供输入/粘贴/打开分享链接的加入按钮). */}
          </div>
        )}

        {phase === 'error' && !rowsAvailable && (
          <div
            className="mt-[24px] rounded-[13px] border border-destructive/25 bg-destructive/8 px-4 py-4 text-sm text-destructive"
            data-testid="my-circles-error"
          >
            <p className="m-0">{t('poo70.c3.state.errorTitle')}</p>
            <button
              type="button"
              data-testid="my-circles-retry"
              onClick={handleRetry}
              className="mt-[10px] inline-flex min-h-[30px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            >
              {t('poo70.c3.action.retry')}
            </button>
          </div>
        )}

        {phase === 'offline' && !rowsAvailable && (
          <div
            className="mt-[24px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-4 text-sm text-info-text"
            data-testid="my-circles-offline"
          >
            <p className="m-0">{t('poo70.c3.state.offlineTitle')}</p>
            <button
              type="button"
              data-testid="my-circles-retry"
              onClick={handleRetry}
              className="mt-[10px] inline-flex min-h-[30px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            >
              {t('poo70.c3.action.retry')}
            </button>
          </div>
        )}

        {phase === 'partial' && (
          <div
            className="mt-[24px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
            data-testid="my-circles-partial-banner"
          >
            {t('poo70.c3.state.partial')}
          </div>
        )}

        {/* A FAILED REFRESH over retained rows must never silently blank the
        list (P70-HOME-03 analog): the last authoritative rows stay, the stale
        banner explains and carries the explicit retry. */}
        {rowsAvailable && hasReceiptErrors && phase !== 'partial' && (
          <div
            className="mt-[24px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
            data-testid="my-circles-stale-banner"
          >
            <span>{t('poo70.c3.state.stale')}</span>
            <button
              type="button"
              data-testid="my-circles-stale-retry"
              onClick={handleRetry}
              className="inline-flex min-h-[28px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            >
              {t('poo70.c3.action.retry')}
            </button>
          </div>
        )}

        {/* Prototype `.r14-toolbar`: search + entitlement filter. Hidden while
        the list surface cannot be verified AND nothing is retained; the
        legitimate empty-relations phase shows no toolbar (prototype
        P-M07-EMPTY). */}
        {rowsAvailable && phase !== 'empty' && (
          <div className="mb-[24px] flex flex-wrap items-end gap-[16px]" data-testid="my-circles-toolbar">
            <label className="grid min-w-[220px] flex-1 gap-[6px] text-[12px] text-muted-foreground">
              <span>{t('poo70.c3.search.label')}</span>
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('poo70.c3.search.placeholder')}
                data-testid="my-circles-search"
                className="min-h-[38px] w-full appearance-none rounded-[8px] border border-border bg-surface px-[12px] py-[9px] text-[15px] text-foreground outline-none focus-visible:border-accent [&::-webkit-search-cancel-button]:appearance-none"
              />
            </label>
            <label className="grid gap-[6px] text-[12px] text-muted-foreground">
              <span>{t('poo70.c3.filter.label')}</span>
              <select
                value={filter}
                onChange={event => setFilter(event.target.value as MyCirclesEntitlementFilter)}
                data-testid="my-circles-filter"
                className="min-h-[38px] rounded-[8px] border border-border bg-surface px-[12px] py-[9px] text-[15px] text-foreground"
              >
                <option value="all">{t('poo70.c3.filter.all')}</option>
                <option value="valid">{t('poo70.c3.filter.valid')}</option>
                <option value="restore">{t('poo70.c3.filter.restore')}</option>
              </select>
            </label>
          </div>
        )}

        {rowsAvailable && phase !== 'empty' && resource.state.refreshing && (
          <span className="mt-[12px] inline-block text-[12px] text-muted-foreground" data-testid="my-circles-refreshing">
            {t('poo70.c3.state.refreshing')}
          </span>
        )}

        {searchNoMatch && (
          <div
            className="mt-[24px] grid justify-items-center gap-[10px] rounded-[16px] border border-border bg-surface px-[20px] py-[28px] text-center"
            data-testid="my-circles-no-match"
          >
            <p className="m-0 text-[14px] text-foreground">{t('poo70.c3.state.noMatch')}</p>
            <p className="m-0 text-[12px] text-muted-foreground">{t('poo70.c3.state.noMatchHint')}</p>
            <button
              type="button"
              data-testid="my-circles-clear-filters"
              onClick={() => {
                setQuery('')
                setFilter('all')
              }}
              className="inline-flex min-h-[30px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            >
              {t('poo70.c3.action.clearFilters')}
            </button>
          </div>
        )}

        {showList && visibleRows.length > 0 && (
          <section className="mt-[16px]">
            <div className="grid gap-[12px]" data-testid="my-circles-list">
              {visibleRows.map(row => (
                <MemberCircleRow
                  key={row.circleId}
                  model={row}
                  onOpen={handleOpenRow}
                />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
