import { useTranslation } from 'react-i18next'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { LocalAppRuntimeStatus } from '@polo-ai/shared/protocol'

/**
 * POO-70 H2 (P70-CARD-01): the shared member App card for the home AND the
 * circle detail views — one presentational component owning the icon, name,
 * creator/source line, spacing and open button so every consumer renders the
 * same work card.
 *
 * Variant contract (P70-CARD-01):
 * - `home`: the frozen home quick-entry card. It has NO bottom-left resident
 *   status badge and NO source COUNT — only the device runtime badge while
 *   an App is actually running, and the creator/source NAMES line.
 * - `detail`: the same card for circle detail consumption. It KEEPS the
 *   source identification line (which circle/creator provides the work) and
 *   never renders runtime controls.
 *
 * The card is strictly presentational: every action is delegated through
 * `onOpen`, and the launch authority stays with the caller's
 * `useMemberAppActions` / existing catalog flow. Source attribution follows
 * the frozen POO-41 contract: every server-authoritative `catalogSources`
 * entry stays visible with its identity (creator_circle entries carry the
 * localized 认证创作者 label), multiplicity is preserved, and identity is
 * never taken from display names.
 */
export type MemberAppCardVariant = 'home' | 'detail'

export interface MemberAppCardProps {
  app: CatalogApp
  onOpen: (app: CatalogApp) => void
  variant: MemberAppCardVariant
  /**
   * `home` variant only: the current device runtime status of this App.
   * Looked up by the caller through the runtime scope key; a card without
   * one simply shows no badge.
   */
  runtimeStatus?: LocalAppRuntimeStatus | null
  /**
   * Stable UI identity of the App (data-identity-key), used by tests and
   * never as an authorization fact.
   */
  identityKey?: string
  /** DOM test id; consumers with an established contract pass their own. */
  testId?: string
  /** An authoritative open/prepare action is already in flight. */
  busy?: boolean
  /**
   * Visibly UNAVAILABLE row (POO-70 visual review R1 F2): the card is not
   * clickable and the open action renders disabled — the caller renders the
   * concrete reason beside the card (the C4 不可用作品说明 pattern). The
   * fail-closed launch gate stays with the caller either way; this prop only
   * makes an already-blocked row LOOK blocked instead of silently toasting.
   */
  openDisabled?: boolean
}

export function MemberAppCard({
  app,
  onOpen,
  variant,
  runtimeStatus = null,
  identityKey,
  testId = 'member-app-card',
  busy = false,
  openDisabled = false,
}: MemberAppCardProps) {
  const { t } = useTranslation()
  // Frozen POO-41 source contract: authoritative catalogSources first, the
  // legacy sourceNames projection as fallback, joined for the single
  // creator/source line.
  const sources = app.catalogSources?.length
    ? app.catalogSources
    : (app.sourceNames ?? []).map((name) => ({ kind: '', name }))
  const sourceLine = sources.length === 0
    ? t('homeApps.allApps.unknownSource')
    : sources
      .map((source) => (
        source.kind === 'creator_circle' && source.name
          ? t('homeApps.home.certifiedCreatorSource', { creator: source.name })
          : source.name || t('homeApps.allApps.unknownSource')
      ))
      .join(' · ')
  // The running badge is a home-variant, actually-running-only marker —
  // never a resident status label and never rendered on detail cards.
  const running = variant === 'home' && runtimeStatus?.status === 'running'
  const handleOpen = () => {
    if (openDisabled) return
    if (!busy) onOpen(app)
  }
  return (
    <article
      data-testid={testId}
      data-identity-key={identityKey}
      data-variant={variant}
      aria-busy={busy}
      data-open-disabled={openDisabled ? 'true' : 'false'}
      onClick={handleOpen}
      className={
        openDisabled
          ? 'flex min-h-[210px] min-[1081px]:min-h-[222px] flex-col rounded-[20px] border border-foreground/10 bg-surface p-[18px] opacity-70 shadow-xs min-[1081px]:p-[20px]'
          : 'flex min-h-[210px] min-[1081px]:min-h-[222px] cursor-pointer flex-col rounded-[20px] border border-foreground/10 bg-surface p-[18px] shadow-xs transition-shadow hover:shadow-minimal min-[1081px]:p-[20px]'
      }
    >
      {/* Prototype `.app-art`: accent-soft fill + accent glyph (POO-70 visual
      review R1 F7 — the brick-green success tint was a token deviation). */}
      <span className="mb-[26px] grid size-[42px] flex-none place-items-center overflow-hidden rounded-[13px] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-accent">
        {app.iconUrl
          ? <img src={app.iconUrl} alt="" className="size-full object-cover" />
          : <span className="text-[17px] font-semibold">{app.name.slice(0, 1)}</span>}
      </span>
      <h3 className="m-0 text-[16px] font-bold leading-[normal]">{app.name}</h3>
      <p className="mt-[4px] truncate text-[12px] leading-[normal] text-muted-foreground">
        {sourceLine}
      </p>
      <p className="mt-[17px] text-[13px] leading-[1.6] text-muted-foreground">
        {app.description || t('homeApps.noDescription')}
      </p>
      <div
        className={
          running
            ? 'mt-auto flex items-center justify-between gap-[6px] pt-[14px]'
            : 'mt-auto flex items-center justify-end gap-[7px] pt-[14px]'
        }
      >
        {running && (
          <span className="inline-flex min-h-[20px] items-center gap-[5px] whitespace-nowrap rounded-[4px] bg-info/10 px-[7px] text-[10px] font-medium text-info">
            <span className="size-[5px] rounded-full bg-info" aria-hidden="true" />
            {t('homeApps.status.running')}
          </span>
        )}
        {/* Prototype `.home-app-grid .card-action`: borderless quiet label,
        fg-5 hover fill; `:disabled` dims to opacity .48 with a not-allowed
        cursor. The click never navigates by itself — the caller's authorized
        open flow decides. */}
        <button
          type="button"
          disabled={busy || openDisabled}
          className={
            openDisabled
              ? 'inline-flex min-h-[30px] cursor-not-allowed items-center justify-center whitespace-nowrap rounded-[6px] border-0 bg-transparent px-[9px] text-[12px] font-medium text-foreground-60 opacity-60'
              : 'inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[6px] border-0 bg-transparent px-[9px] text-[12px] font-medium text-foreground-60 hover:bg-foreground-5 hover:text-foreground'
          }
          onClick={(event) => {
            event.stopPropagation()
            handleOpen()
          }}
        >
          {busy ? t('common.loading') : t('common.open')}
        </button>
      </div>
    </article>
  )
}
