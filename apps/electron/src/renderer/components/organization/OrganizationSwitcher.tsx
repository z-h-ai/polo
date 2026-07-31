import { Building2, Check, ChevronDown, Package, Settings2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { TopBarButton } from '@/components/ui/TopBarButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { useOptionalOrganizationContext } from '@/context/OrganizationContext'
import { cn } from '@/lib/utils'

export function OrganizationSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const organization = useOptionalOrganizationContext()
  if (!organization) return null

  const active = organization.organizationSummaries.find(
    item => item.id === organization.activeOrganizationId,
  )
  if (!active) return null

  const ActiveIcon = active.type === 'creator_space' ? Sparkles : Building2
  const canManage = organization.organizationMembershipRole === 'owner'
    || organization.organizationMembershipRole === 'manager'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <TopBarButton
            data-testid="organization-switcher"
            aria-label={t('organization.switcher.label')}
            className="rounded-[8px]"
          >
            <ActiveIcon className="size-4 text-accent" />
          </TopBarButton>
        ) : (
          <button
            type="button"
            data-testid="organization-switcher"
            className={cn(
              'titlebar-no-drag flex h-[28px] max-w-52 items-center gap-1.5 rounded-lg px-2',
              'text-sm text-foreground/80 hover:bg-foreground/5',
            )}
          >
            <ActiveIcon className="size-3.5 shrink-0 text-accent" />
            <span className="truncate">{active.name}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start" minWidth="min-w-56">
        {organization.organizationSummaries.map(item => {
          const Icon = item.type === 'creator_space' ? Sparkles : Building2
          const selected = item.id === organization.activeOrganizationId
          return (
            <StyledDropdownMenuItem
              key={item.id}
              data-testid="organization-switcher-row"
              onClick={() => organization.onSelectOrganization(item.id)}
            >
              <Icon className="size-3.5 text-accent" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {t(`organization.role.${item.membership.role}`)}
              </span>
              {selected ? <Check className="size-3.5" /> : null}
            </StyledDropdownMenuItem>
          )
        })}
        <StyledDropdownMenuSeparator />
        {active.type === 'creator_space' ? (
          <StyledDropdownMenuItem onClick={organization.onManageOrganization}>
            <Package className="size-3.5" />
            {t('creatorSkills.artifacts.title')}
          </StyledDropdownMenuItem>
        ) : null}
        {canManage ? (
          <StyledDropdownMenuItem onClick={organization.onManageOrganization}>
            <Settings2 className="size-3.5" />
            {t('organization.manage.title')}
          </StyledDropdownMenuItem>
        ) : null}
        <StyledDropdownMenuItem onClick={organization.onCreateOrganization}>
          <Building2 className="size-3.5" />
          {t('organization.createAnother')}
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
