import { useTranslation } from 'react-i18next'
import type { MemberCircleUpstreamPendingState } from '@polo-ai/shared/admin'
import type {
  MemberCircleReadError,
  MemberCircleUpstreamReadState,
} from '@/hooks/useMemberCircles'

/**
 * Circle updates panel (POO-70 C5 / POO-94; P70-CIRCLE-UPDATES-01/02/03).
 *
 * Read-only, traceable display of one circle's confirmed updates for the
 * circle-detail "更新" section (prototype scenes P-M07-DETAIL-FOCUS-UPDATES /
 * P-M07-DETAIL-PAID-UPDATES). The panel is a PURE PROJECTION with no data
 * source of its own:
 *
 * - Every fact arrives via props from the C2 shared resource
 *   (`useMemberCircles().updateStates[circleId]`, fed by `getUpdates` /
 *   `refreshUpdates`). The panel issues no read, keeps no cache and holds no
 *   per-circle state of its own — switching `circleId` can only ever show the
 *   props of THAT circle, so a previous scope's receipts cannot bleed through
 *   the panel (P70-CIRCLE-UPDATES-03 旧回执不串圈 holds by construction; the
 *   authoritative scope fence lives in C2, never here).
 *
 * - G2 upstream-expected (F1 contract `member-circle-contract.json`): the
 *   provider has NO member-side updates-history endpoint yet. The only
 *   confirmed updates DTO today is `MemberCircleUpstreamPendingState`
 *   (`availability: 'upstream_pending'`), and this panel renders it as
 *   EXPLICITLY awaiting-upstream — never as an empty-list success, never as
 *   an error, and never with entries fabricated from the prototype demo
 *   content.
 *
 * - P70-CIRCLE-UPDATES-01: confirmed entries render version, summary and the
 *   authoritative publish time under a STABLE ordering (newest first; ties
 *   keep input order; unparsable times sink to the end without being
 *   dropped). "No updates" (legitimately empty entry list) and "read failed"
 *   are distinct, separately-worded states.
 *
 * - P70-CIRCLE-UPDATES-02: informational only. The panel renders NO
 *   open/install/enable action and accepts no callback besides `onRetry` —
 *   an update never opens an app, enables a skill or installs a new version,
 *   and the version actually adopted on next launch is decided by the
 *   existing Runtime, not by this surface.
 *
 * - P70-CIRCLE-UPDATES-03: this section renders no exit/leave control (exit
 *   lives only in the subscription section and is owned by the C9 page
 *   shell). An unauthorized/forbidden read renders the permission state
 *   INSTEAD of any update content (fail closed).
 *
 * Layout is a derived composition over the confirmed workbench tokens
 * (workbench-base/workbench-review): calm list rows separated by hairlines,
 * the shared banner pattern for loading/pending/error states. The full-page
 * combination is still pending design re-review — no parity claim is made.
 */

// ---------------------------------------------------------------------------
// Display contract (props)
// ---------------------------------------------------------------------------

/**
 * One confirmed circle-update entry — the panel's minimal DISPLAY contract
 * for the future F1 updates fixture (fixture_request names versioned DTO
 * semantics: sorting plus per-entry fields). Fields are the ones
 * P70-CIRCLE-UPDATES-01 requires to be traceable: version, summary and the
 * AUTHORITATIVE provider time. The runtime bridge cannot produce entries
 * yet (G2 is upstream-expected), so this shape exists for the re-pin and is
 * exercised only by fixtures — no entry is ever fabricated at runtime.
 */
export interface CircleUpdateEntry {
  /** Stable provider-assigned id; React key (index only as a fallback). */
  readonly id: string
  /** Version as published by the provider — shown verbatim, never guessed. */
  readonly version: string
  /** Short change summary as published by the provider. */
  readonly summary: string
  /** Authoritative publish time from the provider (ISO 8601). */
  readonly publishedAt: string
}

/**
 * The `updates` payload this panel consumes.
 *
 * TODAY the only provider-confirmed shape is the G2 `upstream_pending`
 * capability fact (exactly what C2 `getUpdates`/`refreshUpdates` resolve
 * to). The `entries` arm is the future F1 fixture contract above. Rendering
 * always keeps the two distinguishable: pending-upstream is "the provider
 * has no member-side history yet", an empty entry list is a legitimate
 * "no updates", and neither is ever substituted for the other.
 */
export type CircleUpdatesData =
  | MemberCircleUpstreamPendingState
  | { availability: 'entries'; entries: readonly CircleUpdateEntry[] }

export interface CircleUpdatesPanelProps {
  /** The circle whose updates are shown. Display/traceability only — the
   * authorization subject is derived main-process-side by C1/C2, never here. */
  circleId: string
  /**
   * The circle's confirmed updates payload (C2 `updateStates[circleId]`
   * ready value). `null` means no authoritative updates fact exists in THIS
   * scope yet — rendered as awaiting-upstream, never as empty success.
   */
  updates: CircleUpdatesData | null
  /**
   * C2 read state for `circleId` (`loading` / `ready` / `failed`).
   * Omitted = the read has not been issued yet — rendered as loading.
   */
  state?: MemberCircleUpstreamReadState
  /**
   * Explicit recovery action for a failed read (wire to C2
   * `refreshUpdates(circleId)`). The only callback the panel accepts.
   */
  onRetry?: () => void
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Stable display order for confirmed update entries (P70-CIRCLE-UPDATES-01):
 * newest authoritative time first; ties keep the provider's input order
 * (Array.prototype.sort is NOT guaranteed stable across engines, so the
 * input index is carried explicitly); entries whose time cannot be parsed
 * sink to the end IN INPUT ORDER instead of being dropped — an unparsable
 * fact is still a fact and must not disappear silently.
 */
export function orderCircleUpdatesForDisplay<E extends CircleUpdateEntry>(
  entries: readonly E[],
): E[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.entry.publishedAt)
      const rightTime = Date.parse(right.entry.publishedAt)
      if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
        if (Number.isNaN(leftTime) !== Number.isNaN(rightTime)) {
          // Exactly one unparsable time: the parsable one sorts first.
          return Number.isNaN(leftTime) ? 1 : -1
        }
        return left.index - right.index
      }
      if (leftTime !== rightTime) return rightTime - leftTime
      return left.index - right.index
    })
    .map(positioned => positioned.entry)
}

/**
 * Authoritative time rendering. A parsable ISO time renders in the given
 * locale (medium date + short time); anything unparsable is returned
 * verbatim — the provider string is the fact, a guessed fallback is not.
 */
export function formatCircleUpdateTimestamp(iso: string, locale?: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Permission-blocked read (P70-CIRCLE-UPDATES-03): the identity is not
 * allowed to read this circle's updates, so NO update content may render —
 * the permission state replaces it, fail closed.
 */
const CIRCLE_UPDATES_PERMISSION_BLOCKED_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'forbidden',
])

export function isCircleUpdatesPermissionBlocked(
  error: MemberCircleReadError | null,
): boolean {
  return error !== null && CIRCLE_UPDATES_PERMISSION_BLOCKED_CODES.has(error.code)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The C2 read state actually rendered: an omitted prop means the read has
 * not been issued yet, which presents exactly like an in-flight read.
 */
function resolveReadState(state: CircleUpdatesPanelProps['state']): MemberCircleUpstreamReadState {
  return state ?? { phase: 'loading' }
}

export function CircleUpdatesPanel({
  circleId,
  updates,
  state,
  onRetry,
}: CircleUpdatesPanelProps) {
  const { t } = useTranslation()
  const readState = resolveReadState(state)

  return (
    <section
      className="mt-[34px]"
      data-testid="circle-updates-panel"
      data-circle-id={circleId}
    >
      <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        {t('poo70.c5.title')}
      </h2>

      {readState.phase === 'loading' && (
        <div
          className="mt-[14px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-updates-loading"
          role="status"
        >
          {t('poo70.c5.loading')}
        </div>
      )}

      {readState.phase === 'failed' && (
        <CircleUpdatesFailure
          error={readState.error}
          onRetry={onRetry}
        />
      )}

      {readState.phase === 'ready' && (
        <CircleUpdatesReady
          updates={updates}
        />
      )}
    </section>
  )
}

function CircleUpdatesFailure({
  error,
  onRetry,
}: {
  error: MemberCircleReadError
  onRetry?: () => void
}) {
  const { t } = useTranslation()

  // P70-CIRCLE-UPDATES-03: identity not allowed — show the permission fact
  // INSTEAD of any update content, with no retry affordance (a retry cannot
  // change an authorization verdict).
  if (isCircleUpdatesPermissionBlocked(error)) {
    return (
      <div
        className="mt-[14px] rounded-[13px] border border-destructive/25 bg-destructive/8 px-4 py-3 text-xs text-destructive"
        data-testid="circle-updates-forbidden"
        role="alert"
      >
        <p className="m-0 font-medium">{t('poo70.c5.forbiddenTitle')}</p>
        <p className="m-0 mt-[4px]">{t('poo70.c5.forbiddenBody')}</p>
      </div>
    )
  }

  return (
    <div
      className="mt-[14px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
      data-testid="circle-updates-error"
      role="alert"
    >
      <span>{t('poo70.c5.errorTitle')}</span>
      {onRetry && (
        <button
          type="button"
          data-testid="circle-updates-retry"
          className="inline-flex min-h-[28px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
          onClick={onRetry}
        >
          {t('poo70.c5.retry')}
        </button>
      )}
    </div>
  )
}

function CircleUpdatesReady({
  updates,
}: {
  updates: CircleUpdatesData | null
}) {
  const { t } = useTranslation()

  // No authoritative updates fact in this scope (null), the G2 capability
  // fact itself, or any payload shape this build does not know: render
  // awaiting-upstream. This is a READY capability state — deliberately NOT
  // an empty-list success and NOT an error (F1 gap G2; the provider has no
  // member-side history endpoint yet). Unknown shapes fail closed here
  // instead of being guessed into entries.
  if (updates === null || updates.availability !== 'entries') {
    return (
      <div
        className="mt-[14px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
        data-testid="circle-updates-pending-upstream"
        role="status"
      >
        <p className="m-0 font-medium">{t('poo70.c5.pendingUpstreamTitle')}</p>
        <p className="m-0 mt-[4px]">{t('poo70.c5.pendingUpstreamBody')}</p>
      </div>
    )
  }

  const entries = updates.entries

  // A legitimately empty confirmed list is a real "no updates" success —
  // worded differently from the awaiting-upstream state above, never merged
  // with it (P70-CIRCLE-UPDATES-01: 没有更新与获取失败分别反馈; G2: pending
  // is never faked into empty).
  if (entries.length === 0) {
    return (
      <div
        className="mt-[14px] rounded-[13px] border border-border bg-surface px-4 py-3 text-xs text-muted-foreground"
        data-testid="circle-updates-empty"
        role="status"
      >
        <p className="m-0 font-medium text-foreground">{t('poo70.c5.emptyTitle')}</p>
        <p className="m-0 mt-[4px]">{t('poo70.c5.emptyBody')}</p>
      </div>
    )
  }

  const ordered = orderCircleUpdatesForDisplay(entries)

  return (
    <ul
      className="m-0 mt-[6px] list-none p-0"
      data-testid="circle-updates-list"
    >
      {ordered.map((entry, index) => (
        <li
          key={entry.id || index}
          className="border-b border-border py-[22px] first:pt-[10px] last:border-b-0"
          data-testid={`circle-update-entry-${index}`}
        >
          <div className="flex flex-wrap items-center gap-[8px]">
            <span
              className="inline-flex min-h-[18px] items-center rounded-full bg-foreground/6 px-[7px] text-[10px] font-medium text-muted-foreground"
              data-testid={`circle-update-entry-version-${index}`}
            >
              {entry.version}
            </span>
          </div>
          <p className="m-0 mt-[8px] text-[14px] font-medium leading-[1.5] text-foreground">
            {entry.summary}
          </p>
          <p
            className="m-0 mt-[4px] text-[12px] leading-[1.6] text-muted-foreground"
            data-testid={`circle-update-entry-published-at-${index}`}
          >
            {t('poo70.c5.entryPublishedAt', {
              time: formatCircleUpdateTimestamp(entry.publishedAt),
            })}
          </p>
        </li>
      ))}
    </ul>
  )
}
