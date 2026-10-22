import { Building2, Check } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useClientWorkbenchStyle, clientWorkbenchFocusClassName, clientWorkbenchButtonClassName } from '@/components/ui/client-workbench'
import { cn } from '@/lib/utils'
import type { ProductSpaceSelectionSource } from '@/hooks/useProductSpaceContext'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

export type ProductSpaceSelectAccount = {
  displayName: string
  username: string
}

function spaceInitial(name: string, kind: 'personal' | 'enterprise'): string {
  if (kind === 'personal') return '我'
  const trimmed = name.trim()
  return trimmed ? trimmed[0]!.toUpperCase() : '企'
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
                  'flex w-full items-center gap-[10px] rounded-[10px] border border-transparent px-[12px] py-[9px] text-left transition-colors',
                  'hover:bg-foreground-5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent',
                  isSelected && 'border-border bg-foreground-5',
                )}
              >
                <span
                  className={cn(
                    'flex size-[26px] shrink-0 items-center justify-center rounded-[6px] text-[11px] font-semibold text-accent',
                    'bg-[var(--accent-soft)]',
                  )}
                  aria-hidden="true"
                >
                  {spaceInitial(space.name, space.kind)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  {space.name}
                </span>
                <span className="flex shrink-0 items-center gap-[6px] text-[11px] text-muted-foreground">
                  {space.kind === 'enterprise' ? (
                    <span>{t('spaceSelect.enterpriseTag', { role: t(spaceRoleKey(space.kind, space.role)) })}</span>
                  ) : null}
                  {recommended ? (
                    <span className="rounded-[6px] bg-[var(--accent-soft)] px-[6px] py-[1px] text-[10px] font-medium text-accent" data-testid="product-space-select-recommended-tag">
                      {t('spaceSelect.recommended')}
                    </span>
                  ) : null}
                  {restricted ? (
                    <span className="rounded bg-foreground-10 px-[5px] py-[1px] text-[10px] text-muted-foreground">
                      {t('productSpace.restricted')}
                    </span>
                  ) : null}
                </span>
                {isSelected ? <Check className="size-[16px] shrink-0 text-success" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>

        {selectedRestricted && selected ? (
          <p className="mt-[10px] mb-0 text-[12px] leading-[1.5] text-muted-foreground" data-testid="product-space-select-restricted-note">
            {t('spaceSelect.restrictedNote', { name: selected.name })}
          </p>
        ) : null}

        <Button
          className={clientWorkbenchButtonClassName + ' mt-[22px] w-full'}
          disabled={submitting || selected === null}
          data-testid="product-space-select-confirm"
          onClick={confirm}
        >
          {selected ? t('spaceSelect.enter', { name: selected.name }) : ''}
        </Button>

        <div
          className="mt-[16px] flex items-center justify-between gap-[12px] rounded-[10px] bg-foreground-5 px-[12px] py-[8px] text-left"
          data-testid="product-space-select-account"
          aria-label={t('spaceSelect.accountAriaLabel')}
        >
          <span className="flex min-w-0 items-center gap-[10px]">
            <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[11px] font-semibold text-accent" aria-hidden="true">
              {account?.displayName?.trim()?.[0] ?? '·'}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-foreground">{account?.displayName ?? ''}</span>
              <span className="block truncate text-[11px] text-foreground-40">{account?.username ?? ''}</span>
            </span>
          </span>
          <Button className={clientWorkbenchButtonClassName} variant="ghost" data-testid="product-space-select-logout" onClick={onLogout}>
            {t('topbar.account.logout')}
          </Button>
        </div>
      </section>
    </div>
  )
}
