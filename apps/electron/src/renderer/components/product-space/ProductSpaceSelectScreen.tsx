import { AlertCircle, Building2, Check } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useClientWorkbenchStyle, clientWorkbenchFocusClassName, clientWorkbenchButtonClassName, clientWorkbenchPrimaryClassName } from '@/components/ui/client-workbench'
import { cn } from '@/lib/utils'
import { productSpaceAvatarGlyph } from '@/lib/space-initial'
import type { ProductSpaceSelectionSource } from '@/hooks/useProductSpaceContext'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

export type ProductSpaceSelectAccount = {
  displayName: string
  username: string
}

function spaceRoleKey(kind: 'personal' | 'enterprise', role: string): string {
  return kind === 'personal'
    ? 'productSpace.role.personal'
    : `productSpace.role.${role}`
}

function isRestricted(space: ProductSpaceSummary): boolean {
  return space.kind === 'enterprise' && space.accessMode === 'read_only'
}

function personalFirst(space: ProductSpaceSummary): number {
  return space.kind === 'personal' ? 0 : 1
}

/**
 * SCENE-1/5: the login-time space confirmation gate (Spec M1/M3/M4, 方案 A).
 * Shown only for accounts with ≥2 available spaces. `selectionSource` comes
 * from the bootstrap that committed `activeProductSpaceId` and tells how the
 * target was chosen — the device ledger is NOT read here, because bootstrap
 * overwrites it before this screen mounts (a ledger read would always claim
 * "stored" and kill the first-login recommendation).
 */
export function ProductSpaceSelectScreen({
  spaces,
  activeProductSpaceId,
  selectionSource,
  account,
  submitting = false,
  onConfirm,
  onLogout,
}: {
  spaces: ProductSpaceSummary[]
  activeProductSpaceId: string | null
  selectionSource: ProductSpaceSelectionSource
  account: ProductSpaceSelectAccount | null
  /** A switch transaction is in flight; the CTA stays disabled (no double submit). */
  submitting?: boolean
  onConfirm: (spaceId: string) => void
  onLogout: () => void
}) {
  const { t } = useTranslation()
  const style = useClientWorkbenchStyle()

  // M3 default selection: stored active → first-login recommended active
  // enterprise → bootstrap-committed active as the fallback. 'stored' means
  // bootstrap restored the machine's last-used space into activeProductSpaceId
  // ('memory-invalid': a memory existed but was restricted/removed — S3 keeps
  // it from auto-restoring; 'fresh': no local memory, SCENE-5 first login).
  const { defaultTargetId, recommendedEnterprise } = useMemo(() => {
    const storedUsable = selectionSource === 'stored'
    const recommended = storedUsable
      ? undefined
      : spaces.find(space => space.kind === 'enterprise' && space.accessMode === 'active')
    return {
      recommendedEnterprise: recommended,
      defaultTargetId: (storedUsable
        ? activeProductSpaceId
        : recommended?.id ?? activeProductSpaceId) ?? spaces[0]?.id ?? null,
    }
  }, [activeProductSpaceId, selectionSource, spaces])

  // The default target leads the list; the rest keep personal-first order.
  const orderedSpaces = useMemo(() => {
    const target = spaces.find(space => space.id === defaultTargetId)
    const rest = spaces
      .filter(space => space.id !== defaultTargetId)
      .sort((a, b) => personalFirst(a) - personalFirst(b))
    return target ? [target, ...rest] : rest
  }, [defaultTargetId, spaces])

  // The recommendation badge rides on the recommendation itself; the
  // subtitle names WHY the default was chosen (first login / last-used
  // memory / unusable memory / no recommendation possible).
  const hasRecommendation = recommendedEnterprise !== undefined

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = orderedSpaces.find(space => space.id === (selectedId ?? defaultTargetId)) ?? null
  const selectedRestricted = selected !== null && isRestricted(selected)

  const confirm = useCallback(() => {
    if (submitting || selected === null) return
    onConfirm(selected.id)
  }, [onConfirm, selected, submitting])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (orderedSpaces.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const index = orderedSpaces.findIndex(space => space.id === selected?.id)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = orderedSpaces[(((index === -1 ? 0 : index) + delta) % orderedSpaces.length + orderedSpaces.length) % orderedSpaces.length]
      if (next) setSelectedId(next.id)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      confirm()
    }
  }, [confirm, orderedSpaces, selected])

  return (
    <div style={style} className={clientWorkbenchFocusClassName + ' flex h-full items-center justify-center overflow-y-auto bg-background p-[32px]'} data-testid="product-space-select-screen">
      <section className="w-full max-w-[520px] rounded-[20px] border border-border bg-surface p-[30px] text-center shadow-modal-small">
        <span className="mx-auto mb-[18px] grid size-[52px] place-items-center rounded-[14px] bg-[var(--info-soft)] text-info" aria-hidden="true">
          <Building2 className="size-[25px]" />
        </span>
        <h1 className="m-0 text-[24px] font-[720] tracking-[-0.035em] text-foreground">{t('spaceSelect.title')}</h1>
        <p className="mt-[9px] text-[13px] leading-[1.58] text-foreground-60">
          {t(recommendedEnterprise !== undefined
            ? (selectionSource === 'fresh'
              ? 'spaceSelect.subtitleFirstLogin'
              : 'spaceSelect.subtitleUnavailableMemory')
            : selectionSource === 'stored'
              ? 'spaceSelect.subtitleReturning'
              : 'spaceSelect.subtitleNoRecommendation')}
        </p>

        <div
          role="listbox"
          aria-label={t('spaceSelect.listAriaLabel')}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="mt-[22px] flex flex-col gap-[6px] text-left outline-none"
        >
          {orderedSpaces.map(space => {
            const isSelected = space.id === selected?.id
            const restricted = isRestricted(space)
            const recommended = hasRecommendation && space.id === defaultTargetId
              && space.kind === 'enterprise'
            return (
              <button
                key={space.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-testid="product-space-select-item"
                data-space-id={space.id}
                data-space-kind={space.kind}
                data-active={isSelected}
                data-restricted={restricted}
                onClick={() => setSelectedId(space.id)}
                className={cn(
                  // 方案 A 行组合（原型 .space-row）：两行 meta（名称 + 标记），52px 最小行高。
                  'flex min-h-[52px] w-full items-center gap-[11px] rounded-[10px] border border-transparent px-[12px] py-[9px] text-left transition-colors',
                  'hover:bg-foreground-5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent',
                  isSelected && 'border-accent/30 bg-foreground-5 client-material-selected',
                )}
              >
                <span
                  className={cn(
                    'flex size-[26px] shrink-0 items-center justify-center rounded-[6px] text-[11px] font-semibold text-accent',
                    'bg-[var(--accent-soft)]',
                  )}
                  aria-hidden="true"
                >
                  {(() => {
                    // Journey #9: the glyph is localized (never hardcoded CJK)
                    // — zh-Hans renders 我/企, other locales their own word.
                    const glyph = productSpaceAvatarGlyph(space.name, space.kind)
                    return glyph.kind === 'letter' ? glyph.letter : t(glyph.key)
                  })()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-[13px] font-semibold leading-[1.3]', !isSelected && 'text-foreground')}>
                    {space.name}
                  </span>
                  <span className="mt-[2px] flex items-center gap-[6px]">
                    <span className="inline-flex items-center whitespace-nowrap rounded-full bg-foreground-5 px-[7px] py-[1px] text-[11px] leading-[1.6] text-foreground-60">
                      {space.kind === 'enterprise'
                        ? t('spaceSelect.enterpriseTag', { role: t(spaceRoleKey(space.kind, space.role)) })
                        : t(spaceRoleKey(space.kind, 'personal'))}
                    </span>
                    {recommended ? (
                      <span
                        className="inline-flex items-center whitespace-nowrap rounded-full bg-[var(--accent-soft)] px-[7px] py-[1px] text-[11px] font-semibold leading-[1.6] text-accent"
                        data-testid="product-space-select-recommended-tag"
                      >
                        {t('spaceSelect.recommended')}
                      </span>
                    ) : null}
                    {restricted ? (
                      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-[var(--destructive-soft)] px-[7px] py-[1px] text-[11px] leading-[1.6] text-destructive">
                        {t('productSpace.restricted')}
                      </span>
                    ) : null}
                  </span>
                </span>
                {isSelected ? <Check className="size-[16px] shrink-0 text-success" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>

        {selectedRestricted && selected ? (
          <p
            className="mt-[14px] m-0 flex items-start gap-[8px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-left text-[12px] leading-[1.55] text-destructive"
            role="status"
            data-testid="product-space-select-restricted-note"
          >
            <AlertCircle className="mt-[2px] size-[14px] shrink-0" aria-hidden="true" />
            <span>{t('spaceSelect.restrictedNote', { name: selected.name })}</span>
          </p>
        ) : null}

        <Button
          className={clientWorkbenchPrimaryClassName + ' mt-[22px] min-h-[40px] w-full text-[13px] font-semibold'}
          disabled={submitting || selected === null}
          data-testid="product-space-select-confirm"
          onClick={confirm}
        >
          {selected ? t('spaceSelect.enter', { name: selected.name }) : ''}
        </Button>

        <div
          className="mt-[18px] flex items-center gap-[10px] border-t border-border pt-[16px] text-left"
          data-testid="product-space-select-account"
          aria-label={t('spaceSelect.accountAriaLabel')}
        >
          <span className="flex size-[28px] shrink-0 items-center justify-center rounded-full bg-foreground-10 text-[12px] font-semibold text-foreground-70" aria-hidden="true">
            {account?.displayName?.trim()?.[0] ?? '·'}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-semibold leading-[1.35] text-foreground">{account?.displayName ?? ''}</span>
            <span className="block truncate text-[11px] leading-[1.35] text-foreground-50">{account?.username ?? ''}</span>
          </span>
          <Button className={clientWorkbenchButtonClassName + ' ml-auto shrink-0'} data-testid="product-space-select-logout" onClick={onLogout}>
            {t('topbar.account.logout')}
          </Button>
        </div>
      </section>
    </div>
  )
}
