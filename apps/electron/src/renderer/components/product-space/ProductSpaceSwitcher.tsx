import { useClientWorkbenchStyle, clientWorkbenchMenuClassName } from '@/components/ui/client-workbench'
import { Check, Building2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenuSub,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { cn } from '@/lib/utils'

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

export function ProductSpaceSwitcher() {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const space = useOptionalProductSpaceContext()
  if (!space) return null

  const active = space.activeProductSpace
  if (!active) return null

  return (
    <DropdownMenuSub>
      <StyledDropdownMenuSubTrigger data-testid="product-space-switcher">
        <Building2 className="size-3.5" />
        <span className="flex-1">{t('productSpace.switcher.label')}</span>
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent
        style={workbenchStyle}
        className={clientWorkbenchMenuClassName + " w-[min(306px,calc(100vw-24px))]"}
        minWidth="min-w-0"
      >
        <div className="px-[9px] pb-[5px] pt-[8px] text-[11px] font-medium text-foreground-40">
          {t('productSpace.switcher.menuLabel')}
        </div>
        {space.productSpaces.map(item => {
          const selected = item.id === space.activeProductSpaceId
          const restricted = item.kind === 'enterprise' && item.accessMode === 'read_only'
          return (
            <StyledDropdownMenuItem
              key={item.id}
              data-testid="product-space-item"
              data-space-kind={item.kind}
              data-space-name={item.name}
              data-active={selected}
              data-restricted={restricted}
              className={selected ? "bg-foreground-5" : undefined}
              disabled={selected}
              onClick={() => space.onSelectProductSpace(item.id)}
            >
              <span
                className={cn(
                  'flex size-[26px] shrink-0 items-center justify-center rounded-[6px] text-[11px] font-semibold text-accent',
                  'bg-[var(--accent-soft)]',
                )}
              >
                {spaceInitial(item.name, item.kind)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {item.name}
                {restricted ? (
                  <span className="ml-1 text-[11px] text-muted-foreground">
                    {t('productSpace.restricted')}
                  </span>
                ) : null}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t(spaceRoleKey(item.kind, item.kind === 'enterprise' ? item.role : 'personal'))}
              </span>
              {selected ? <Check className="size-3.5 text-success" /> : null}
            </StyledDropdownMenuItem>
          )
        })}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** D-PC-10: the header displays identity; account-menu owns switching. */
export function CurrentProductSpaceLabel() {
  const { t } = useTranslation()
  const active = useOptionalProductSpaceContext()?.activeProductSpace
  if (!active) return null
  return (
    <div data-testid="product-space-current-label" className="flex h-[36px] max-w-[190px] items-center gap-[8px] px-[10px] [@media(max-width:760px)]:max-w-[110px]">
      <span className="size-2 shrink-0 rounded-full bg-accent" />
      <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{active.name}</span>
      {active.kind === 'enterprise' && active.accessMode === 'read_only' ? (
        <span className="shrink-0 rounded bg-foreground-10 px-1 text-[10px] text-muted-foreground">{t('productSpace.restricted')}</span>
      ) : null}
    </div>
  )
}
