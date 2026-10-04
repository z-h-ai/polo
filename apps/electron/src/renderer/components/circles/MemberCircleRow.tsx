import { useTranslation } from 'react-i18next'
import type { MemberCircleDisplayField } from '@/lib/member-circle-view'

/**
 * POO-70 C3 (P70-CIRCLE-LIST-01/03) — the ONE unified member circle row.
 *
 * Free / paid-monthly / paid-yearly (and restricted) memberships all render
 * through this single row component: identity (avatar + name), the
 * creator line, the summary line, the ENTITLEMENT term at a FIXED position
 * (left of the meta row) with the entitlement counts beside it, and the
 * single 查看详情 action at the right edge. There is no second card layout
 * for any billing kind (Spec §13.11: 轻量权益文字与头像配色区分).
 *
 * The row is strictly presentational and consumes ONLY the normalized
 * `MemberCircleRowModel` built by MyCirclesPage from the C2 authoritative
 * receipts. It never reads the bridge, never judges entitlements and never
 * fabricates display fields:
 * - the creator name is a G1 `upstream_pending` capability fact — rendered as
 *   awaiting-upstream, never derived from `ownerUserId`;
 * - the summary line renders only a CONFIRMED field; absent data stays
 *   absent (no invented 更新, P70-CIRCLE-LIST-03);
 * - the click hands the STABLE `circleId` to `onOpen` — navigation is the
 *   caller's decision.
 */

/** Entitlement lifecycle bucket of one row; also the filter axis (P70-CIRCLE-LIST-02). */
export type MemberCircleEntitlementState = 'valid' | 'restore'

/** Avatar tone derived from CONFIRMED billing facts only (no month/year guess). */
export type MemberCircleAvatarTone = 'free' | 'paid' | 'restricted'

/**
 * Normalized row model (交接接口: CircleRow 接受规范化 model). Built from the
 * C2 receipts by `normalizeMemberCircleRow` — the row itself never touches
 * raw DTOs, so every consumer renders the identical structure.
 */
export interface MemberCircleRowModel {
  /** Stable circle id (P70-CIRCLE-LIST-03) — the ONLY navigation identity. */
  circleId: string
  membershipId: string | null
  name: string
  /** First grapheme of the confirmed name (surrogate-pair safe). */
  avatarChar: string
  avatarTone: MemberCircleAvatarTone
  /** G1: creator display name is upstream-pending — never fabricated. */
  creatorName: MemberCircleDisplayField<string>
  /** Confirmed summary text; null = honestly absent (no invented update line). */
  summary: string | null
  /** Fixed-position entitlement term line (免费/订阅/待恢复 + confirmed date). */
  termText: string
  entitlementState: MemberCircleEntitlementState
  /** Confirmed-typed entitlement counts ('web_app' → App, 'skill' → 技能). */
  appsCount: number
  skillsCount: number
}

export interface MemberCircleRowProps {
  model: MemberCircleRowModel
  /** Click handoff: receives the model whose `circleId` is the stable id. */
  onOpen: (model: MemberCircleRowModel) => void
  /** DOM test id; the list passes the established per-row contract id. */
  testId?: string
}

/** Tone classes per avatar bucket (design tokens: success / accent / neutral). */
const AVATAR_TONE_CLASSES: Record<MemberCircleAvatarTone, string> = {
  free: 'bg-[color-mix(in_srgb,var(--success)_10%,var(--background))] text-success',
  paid: 'bg-[color-mix(in_srgb,var(--accent)_13%,var(--background))] text-accent',
  restricted: 'bg-foreground-5 text-foreground-60',
}

export function MemberCircleRow({ model, onOpen, testId = 'circle-row' }: MemberCircleRowProps) {
  const { t } = useTranslation()
  const creatorLine = model.creatorName.readiness === 'ready'
    ? model.creatorName.value
    : t('poo70.c3.list.creatorPending')
  const countText = model.appsCount > 0 && model.skillsCount > 0
    ? `${t('poo70.c3.count.apps', { count: model.appsCount })} · ${t('poo70.c3.count.skills', { count: model.skillsCount })}`
    : model.appsCount > 0
      ? t('poo70.c3.count.apps', { count: model.appsCount })
      : model.skillsCount > 0
        ? t('poo70.c3.count.skills', { count: model.skillsCount })
        : t('poo70.c3.count.none')
  return (
    // Review cascade: grid 52px / minmax(0,1fr) / auto, gap 20, padding 24,
    // radius 20; base card surface + minimal shadow; hover lifts border toward
    // accent. The row is NOT itself a navigation surface — only the explicit
    // 查看详情 action opens detail.
    <article
      data-testid={testId}
      data-circle-id={model.circleId}
      data-entitlement-state={model.entitlementState}
      className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-[20px] rounded-[20px] border border-border bg-surface p-[24px] shadow-xs transition-[border-color,box-shadow] hover:border-accent/35 hover:shadow-middle max-[850px]:grid-cols-[44px_minmax(0,1fr)_auto] max-[850px]:gap-[14px] max-[850px]:p-[20px]"
    >
      <span
        aria-hidden="true"
        className={`grid size-[52px] flex-none place-items-center rounded-[16px] text-[20px] font-bold max-[850px]:size-[44px] max-[850px]:rounded-[14px] max-[850px]:text-[18px] ${AVATAR_TONE_CLASSES[model.avatarTone]}`}
      >
        {model.avatarChar}
      </span>
      <div className="block min-w-0">
        <div className="m-0 block">
          <h2 className="m-0 mb-[4px] text-[18px] font-bold leading-[1.45] tracking-[-0.02em] max-[850px]:text-[17px]">
            {model.name}
          </h2>
        </div>
        <p className="m-0 mb-[10px] truncate text-[12px] text-foreground-50" data-testid="circle-row-creator">
          {creatorLine}
        </p>
        {model.summary !== null && (
          <p className="m-0 mb-[12px] mt-[8px] text-[13px] leading-[1.6] text-foreground-70" data-testid="circle-row-summary">
            {model.summary}
          </p>
        )}
        {/* FIXED entitlement position: term first, counts beside it — identical
        slot for free / paid / restricted rows (P70-CIRCLE-LIST-01). */}
        <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] text-[12px] leading-[1.6] text-foreground-50">
          <span className="text-foreground-70" data-testid="circle-row-term">{model.termText}</span>
          <span className="border-l border-border pl-[16px]" data-testid="circle-row-count">{countText}</span>
        </div>
      </div>
      <button
        type="button"
        data-testid="circle-row-open"
        className="inline-flex min-h-[32px] items-center justify-center whitespace-nowrap self-center rounded-[8px] border-0 bg-transparent px-[12px] text-[13px] font-medium text-accent hover:bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]"
        onClick={() => onOpen(model)}
      >
        {t('poo70.c3.row.open')}
      </button>
    </article>
  )
}
