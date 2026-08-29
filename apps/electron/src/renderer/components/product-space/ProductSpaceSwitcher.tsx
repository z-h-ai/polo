import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
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

export function ProductSpaceSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const space = useOptionalProductSpaceContext()
  if (!space) return null

  const active = space.activeProductSpace
  if (!active) return null

  const activeInitial = spaceInitial(active.name, active.kind)
  const activeRestricted = active.kind === 'enterprise' && active.accessMode === 'read_only'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            type="button"
            data-testid="product-space-switcher"
            aria-label={t('productSpace.switcher.label')}
            className="titlebar-no-drag flex h-[26px] w-[26px] items-center justify-center rounded-[8px] hover:bg-foreground/5"
          >
            <span
              className={cn(
                'flex size-4 items-center justify-center rounded-full text-[9px] font-semibold text-primary-foreground',
                active.kind === 'personal' ? 'bg-teal-600' : 'bg-indigo-500',
              )}
            >
              {activeInitial}
            </span>
          </button>
        ) : (
          <button
            type="button"
            data-testid="product-space-switcher"
            aria-label={t('productSpace.switcher.label')}
            className="titlebar-no-drag flex h-[28px] max-w-52 items-center gap-1.5 rounded-lg px-2 text-sm text-foreground/80 hover:bg-foreground/5"
          >
            <span
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-primary-foreground',
                active.kind === 'personal' ? 'bg-teal-600' : 'bg-indigo-500',
              )}
            >
              {activeInitial}
            </span>
            <span className="truncate">{active.name}</span>
            {activeRestricted ? (
              <span className="shrink-0 rounded bg-foreground/10 px-1 text-[10px] text-muted-foreground">
                {t('productSpace.restricted')}
              </span>
            ) : null}
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start" minWidth="min-w-56">
        <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
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
              disabled={item.id === space.activeProductSpaceId}
              onClick={() => space.onSelectProductSpace(item.id)}
            >
              <span
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-primary-foreground',
                  item.kind === 'personal' ? 'bg-teal-600' : 'bg-indigo-500',
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
              {selected ? <Check className="size-3.5" /> : null}
            </StyledDropdownMenuItem>
          )
        })}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
