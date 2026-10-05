import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemberCircleSupportState } from '@polo-ai/shared/admin'
import { useMemberCircles } from '@/context/MemberCircleResourceContext'
import type { MemberCircleReadError, MemberCircleSupportReadState } from '@/hooks/useMemberCircles'

/**
 * Circle support panel (POO-70 S1 / POO-98; P70-SUPPORT-01/02/03).
 *
 * Help entry for an exception on the user's OWN circle/order (prototype
 * scenes P-M07-SUPPORT / P-M07-SUPPORT-LOAD-FAIL; POL-115 D-OPS-17). The
 * panel is a READ-ONLY projection with no write surface of its own:
 *
 * - P70-SUPPORT-01: the support QR-code fact comes EXCLUSIVELY from the real
 *   platform configuration consumed through C2
 *   (`useMemberCircles().supportState`, fed by `getSupport` /
 *   `refreshSupport`). Unconfigured (`availability: 'available'` with
 *   `configured: false`), read-failed (`availability: 'load_failed'`, or a
 *   failed C2 bridge read) and awaiting-upstream
 *   (`availability: 'upstream_pending'`, G4 — the member-side endpoint does
 *   not exist yet) are DISTINCT real states, never merged and never faked
 *   into each other. No sample QR code is ever rendered: the confirmed G4
 *   DTO carries no QR asset, so even the configured arm renders the fact and
 *   the provider's `guidance` text — never a scannable placeholder. A failed
 *   support read does not touch the order/membership facts — the panel holds
 *   no such state at all and issues no write.
 *
 * - P70-SUPPORT-02: copyable information is limited to the user's OWN
 *   circle/order facts assembled by C9 into `target` — order number, circle
 *   identifier/name and a necessary issue summary (`supportCopyFacts` is the
 *   type-level allowlist; no token / verification-code / phone field exists
 *   on the target). `redactSensitiveFacts` additionally masks phone-shaped
 *   digit runs inside the free-text summary as defense in depth. Copying is
 *   a local clipboard write by the user — the panel creates NO support
 *   ticket, sends no message and issues no POST (it has no such callback).
 *
 * - P70-SUPPORT-03: 返回原页面 (`onBack`) hands control back to C9, which
 *   keeps the ORIGINAL circle/order and its ORIGINAL exception visible —
 *   the panel owns no routing state and mutates nothing, so closing it
 *   cannot clear or rewrite the original facts. Re-verification of the
 *   original object happens ONLY through the manual `onRecheck` button;
 *   there is no timer, no auto-retry and no payment/join retry surface.
 *   The only automatic behavior is the FIRST authoritative support read on
 *   mount when C2 holds no receipt yet (`supportState === null`); every
 *   later reload is an explicit click.
 *
 * The G4 `upstream_pending` state renders as an explicit awaiting-upstream
 * fact (like C5's G2 panel) — never as an empty success and never as an
 * error; copy stays available there because the copied facts are the user's
 * own order/circle/issue facts, independent of the QR configuration.
 *
 * Layout is a derived composition over the confirmed workbench tokens
 * (calm fact rows, the shared banner pattern, workbench buttons). The full
 * page combination is still pending design re-review — no parity claim.
 */

// ---------------------------------------------------------------------------
// Display contract (props)
// ---------------------------------------------------------------------------

/**
 * The ORIGINAL object the help entry came from, plus the user's own facts
 * that may be copied (P70-SUPPORT-02 allowlist). C9 assembles it from the
 * CURRENT account's own rows only — this panel never accepts another
 * identity's references and never refetches the original object (read-only
 * on it; the re-verification callback stays with C9).
 */
export interface CircleSupportTarget {
  /** Which original object opened the help entry (drives the back label). */
  readonly kind: 'circle' | 'order'
  /** The user's own circle reference, when the original object is a circle. */
  readonly circleId: string | null
  /** The user's own business order number, when the original is an order. */
  readonly orderId: string | null
  /** Circle display name from the user's OWN rows; absent stays absent. */
  readonly circleName: string | null
  /** Necessary summary of the ORIGINAL exception (the user's own fact). */
  readonly issueSummary: string
}

export interface CircleSupportPanelProps {
  /** Original object + own facts (C9-assembled; the panel never mutates it). */
  target: CircleSupportTarget
  /**
   * Back to the ORIGINAL circle/order — C9 must keep the original exception
   * visible (P70-SUPPORT-03). The panel calls it only from the back button.
   */
  onBack: () => void
  /**
   * MANUAL re-verification of the original object (C9 wires the
   * authoritative re-check). Never invoked automatically; omitted = the
   * button does not render.
   */
  onRecheck?: () => void
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Defense-in-depth for the free-text issue summary (P70-SUPPORT-02): masks
 * CN-mobile-shaped digit runs (11 digits starting with 1[3-9]) so a full
 * phone number can never leave through the copy text even if a future C9
 * summary accidentally embedded one. Structured fields (orderId / circleId /
 * circleName) are the user's own allowlisted facts and pass through as-is.
 */
export function redactSensitiveFacts(text: string): string {
  return text.replace(/1[3-9]\d{9}/g, match => `${match.slice(0, 3)}****${match.slice(-2)}`)
}

/** One allowlisted copy fact. `kind` labels the line; nothing else exists. */
export interface SupportCopyFact {
  readonly kind: 'order' | 'circle' | 'issue'
  readonly value: string
}

/**
 * THE copy allowlist (P70-SUPPORT-02): only the user's own order number,
 * circle identity and issue summary — in this fixed order — ever become
 * copy lines. The target type has no token / verification-code / phone
 * field, so such content cannot enter through props; the free-text issue
 * summary additionally passes through `redactSensitiveFacts`.
 */
export function supportCopyFacts(target: CircleSupportTarget): SupportCopyFact[] {
  const facts: SupportCopyFact[] = []
  if (target.orderId) {
    facts.push({ kind: 'order', value: target.orderId })
  }
  if (target.circleName || target.circleId) {
    const circleValue = target.circleName && target.circleId
      ? `${target.circleName} (${target.circleId})`
      : (target.circleName ?? target.circleId!)
    facts.push({ kind: 'circle', value: circleValue })
  }
  if (target.issueSummary) {
    facts.push({ kind: 'issue', value: redactSensitiveFacts(target.issueSummary) })
  }
  return facts
}

/**
 * Permission-blocked support read: the identity is not allowed to read the
 * platform support configuration, so NO support content renders — the
 * permission state replaces it, fail closed (no reload affordance; a retry
 * cannot change an authorization verdict).
 */
const SUPPORT_PERMISSION_BLOCKED_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'forbidden',
])

export function isSupportPermissionBlocked(
  error: MemberCircleReadError | null,
): boolean {
  return error !== null && SUPPORT_PERMISSION_BLOCKED_CODES.has(error.code)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The C2 read state actually rendered: no receipt yet presents exactly like
 * an in-flight read (the mount effect below issues the first read).
 */
function resolveSupportReadState(
  supportState: MemberCircleSupportReadState | null,
): MemberCircleSupportReadState {
  return supportState ?? { phase: 'loading' }
}

export function CircleSupportPanel({
  target,
  onBack,
  onRecheck,
}: CircleSupportPanelProps) {
  const { t } = useTranslation()
  const { state, supportState, getSupport, refreshSupport } = useMemberCircles()

  // First authoritative read only when C2 holds no receipt in THIS scope AND
  // the scope fence is published. The fence gate matters: this panel's effect
  // runs BEFORE the provider's scope effect (child-first passive effects), so
  // an ungated mount call would hit C2's null-fence fail-closed path — which
  // returns without writing any state — and strand the panel in loading
  // forever. With the gate, the read fires when the fence lands (mount or
  // rebind) and never again afterwards: a ready/failed receipt is never
  // auto-refetched, recovery stays the manual reload button (P70-SUPPORT-03).
  const scopeReady = state.scope !== null
  useEffect(() => {
    if (supportState === null && scopeReady) {
      void getSupport()
    }
  }, [supportState, scopeReady, getSupport])

  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const facts = supportCopyFacts(target)
  // Literal keys only — the i18n coverage check verifies literal references.
  const copyLine: Record<SupportCopyFact['kind'], (value: string) => string> = {
    order: value => t('poo70.s1.copyLine.order', { value }),
    circle: value => t('poo70.s1.copyLine.circle', { value }),
    issue: value => t('poo70.s1.copyLine.issue', { value }),
  }
  const copyText = facts.map(fact => copyLine[fact.kind](fact.value)).join('\n')

  const handleCopy = () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard?.writeText) {
      // No clipboard bridge: honest failure — the readonly textarea above
      // stays available for manual copy (spec R13-support: 复制失败手动复制).
      setCopyStatus('failed')
      return
    }
    void clipboard.writeText(copyText).then(
      () => setCopyStatus('copied'),
      () => setCopyStatus('failed'),
    )
  }

  const readState = resolveSupportReadState(supportState)
  const support: MemberCircleSupportState | null = readState.phase === 'ready'
    ? readState.state
    : null
  const permissionBlocked = readState.phase === 'failed'
    && isSupportPermissionBlocked(readState.error)
  // The reload action is an explicit click in every readable state; hidden
  // only for a permission verdict a retry cannot change.
  const showReload = !permissionBlocked

  const backLabel = target.kind === 'order'
    ? t('poo70.s1.backToOrder')
    : t('poo70.s1.backToCircle')

  return (
    <section
      className="mt-[24px] rounded-[13px] border border-border bg-surface px-[18px] py-[20px]"
      data-testid="circle-support-panel"
      data-target-kind={target.kind}
      data-circle-id={target.circleId ?? undefined}
      data-order-id={target.orderId ?? undefined}
    >
      <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        {t('poo70.s1.title')}
      </h2>
      <p className="m-0 mt-[6px] text-[12px] leading-[1.6] text-muted-foreground">
        {t('poo70.s1.description')}
      </p>

      <dl className="m-0 mt-[14px] grid gap-[10px]">
        <div className="grid gap-[2px]" data-testid="circle-support-channel-fact">
          <dt className="text-[12px] text-muted-foreground">{t('poo70.s1.channelLabel')}</dt>
          <dd className="m-0 text-[13px] text-foreground">
            {readState.phase === 'loading' && (
              <span
                className="text-[12px] text-muted-foreground"
                data-testid="circle-support-loading"
                role="status"
              >
                {t('poo70.s1.loading')}
              </span>
            )}

            {readState.phase === 'failed' && !permissionBlocked && (
              <span
                className="text-[12px] text-destructive"
                data-testid="circle-support-error"
                role="alert"
              >
                {t('poo70.s1.errorTitle')}
              </span>
            )}

            {permissionBlocked && (
              <span
                className="block rounded-[10px] border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive"
                data-testid="circle-support-forbidden"
                role="alert"
              >
                <span className="font-medium">{t('poo70.s1.forbiddenTitle')}</span>
                <span className="mt-[2px] block">{t('poo70.s1.forbiddenBody')}</span>
              </span>
            )}

            {support?.availability === 'upstream_pending' && (
              <span
                className="block rounded-[10px] border border-info/20 bg-info/8 px-3 py-2 text-xs text-info-text"
                data-testid="circle-support-pending-upstream"
                role="status"
              >
                <span className="font-medium">{t('poo70.s1.pendingUpstreamTitle')}</span>
                <span className="mt-[2px] block">{t('poo70.s1.pendingUpstreamBody')}</span>
              </span>
            )}

            {support?.availability === 'load_failed' && (
              <span
                className="text-[12px] text-destructive"
                data-testid="circle-support-load-failed"
                role="alert"
              >
                {t('poo70.s1.loadFailed')}
              </span>
            )}

            {support?.availability === 'available' && !support.configured && (
              <span
                className="text-[12px] text-muted-foreground"
                data-testid="circle-support-unconfigured"
                role="status"
              >
                {t('poo70.s1.unconfigured')}
              </span>
            )}

            {support?.availability === 'available' && support.configured && (
              <span data-testid="circle-support-configured" className="text-[12px]">
                {support.guidance !== null
                  ? // The provider's own guidance text — shown verbatim.
                  support.guidance
                  : t('poo70.s1.configuredDefault')}
              </span>
            )}
          </dd>
        </div>
        <div className="grid gap-[2px]" data-testid="circle-support-status-fact">
          <dt className="text-[12px] text-muted-foreground">{t('poo70.s1.statusLabel')}</dt>
          <dd className="m-0 text-[12px] text-muted-foreground">
            {t('poo70.s1.statusNote')}
          </dd>
        </div>
      </dl>

      <label className="mt-[14px] grid gap-[6px] text-[12px] text-muted-foreground">
        {t('poo70.s1.copyLabel')}
        <textarea
          readOnly
          rows={Math.max(2, facts.length)}
          value={copyText}
          aria-label={t('poo70.s1.copyLabel')}
          data-testid="circle-support-info-text"
          className="min-h-[64px] w-full resize-y rounded-[10px] border border-border bg-background px-[12px] py-[8px] text-[13px] leading-[1.6] text-foreground outline-none focus-visible:border-accent"
        />
      </label>
      <p
        className="m-0 mt-[6px] min-h-[18px] text-[12px] text-muted-foreground"
        role="status"
        data-testid="circle-support-copy-status"
      >
        {copyStatus === 'copied' && t('poo70.s1.copied')}
        {copyStatus === 'failed' && t('poo70.s1.copyFailed')}
      </p>

      <div className="mt-[10px] flex flex-wrap items-center gap-[10px]">
        <button
          type="button"
          data-testid="circle-support-copy"
          className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
          onClick={handleCopy}
        >
          {t('poo70.s1.copy')}
        </button>
        {showReload && (
          <button
            type="button"
            data-testid="circle-support-reload"
            className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            onClick={() => void refreshSupport()}
          >
            {t('poo70.s1.reload')}
          </button>
        )}
        {onRecheck && (
          <button
            type="button"
            data-testid="circle-support-recheck"
            className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            onClick={onRecheck}
          >
            {t('poo70.s1.recheck')}
          </button>
        )}
        <button
          type="button"
          data-testid="circle-support-back"
          className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
          onClick={onBack}
        >
          {backLabel}
        </button>
      </div>
    </section>
  )
}
