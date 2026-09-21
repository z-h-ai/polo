import { ArrowLeftRight, Building2, Check, ChevronRight, LogOut, Package, Settings2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import { useOptionalOrganizationContext } from '@/context/OrganizationContext'
import { cn } from '@/lib/utils'

export interface AccountMenuUser {
  username?: string | null
  displayName?: string | null
}

interface AccountMenuProps {
  user: AccountMenuUser | null
  onLogout: () => void | Promise<void>
  onOpenSettings: () => void
}

function isActiveOrganizationSummary(organization: {
  status?: string
  membership: { status: string }
}): boolean {
  return organization.status !== 'suspended'
    && organization.membership.status === 'active'
}

/**
 * AccountMenu - Top-right avatar menu (prototype P-M10-MENU / R9).
 *
 * The top bar keeps a passive space indicator; switching spaces happens only
 * through the 「切换空间」 entry here. The space list contains the personal
 * space and active enterprises only — revoked or suspended spaces are never
 * listed as switchable rows (R10).
 */
export function AccountMenu({ user, onLogout, onOpenSettings }: AccountMenuProps) {
  const { t } = useTranslation()
  const organization = useOptionalOrganizationContext()

  const active = organization?.organizationSummaries.find(
    item => item.id === organization.activeOrganizationId,
  )
  const activeAvailable = organization && active
    ? active.status !== 'suspended' && active.membership.status === 'active'
    : false
  const switchableOrganizations = (organization?.organizationSummaries ?? [])
    .filter(isActiveOrganizationSummary)
    // Personal spaces first, mirroring 「我的空间」 at the top of the prototype list.
    .sort((left, right) => (
      (left.type === 'creator_space' ? 0 : 1) - (right.type === 'creator_space' ? 0 : 1)
    ))
  const canManage = organization && activeAvailable && (
    organization.organizationMembershipRole === 'owner'
    || organization.organizationMembershipRole === 'manager'
  )

  if (!user && !organization) return null

  const displayName = user?.displayName || user?.username || ''
  const initials = displayName.trim().charAt(0).toUpperCase() || '?'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="account-menu"
          aria-label={t('organization.account.openAccountMenu')}
          className="titlebar-no-drag flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--accent),oklch(0.50_0.18_290))] text-xs font-semibold text-white outline-none transition-shadow hover:shadow-minimal focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end" minWidth="min-w-64">
        {displayName && (
          <div className="border-b border-border px-3.5 py-2.5">
            <div className="truncate text-[13px] font-medium text-foreground">{displayName}</div>
            {user?.username && (
              <div className="truncate text-[11px] text-muted-foreground">@{user.username}</div>
            )}
          </div>
        )}

        {organization && (
          <div className="p-1">
            <DropdownMenuSub>
              <StyledDropdownMenuSubTrigger data-testid="account-space-entry">
                <ArrowLeftRight className="size-3.5" />
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="text-[13px] leading-tight">{t('organization.account.switchSpace')}</span>
                  <span className="text-[11px] leading-tight text-muted-foreground">
                    {t('organization.account.currentSpace', { name: active?.name ?? '' })}
                  </span>
                </span>
              </StyledDropdownMenuSubTrigger>
              <StyledDropdownMenuSubContent minWidth="min-w-64">
                {switchableOrganizations.map(item => {
                  const Icon = item.type === 'creator_space' ? Sparkles : Building2
                  const selected = item.id === organization.activeOrganizationId
                  return (
                    <StyledDropdownMenuItem
                      key={item.id}
                      data-testid="organization-switcher-row"
                      onClick={() => organization.onSelectOrganization(item.id)}
                    >
                      <Icon className="size-3.5 text-accent" />
                      <span className="flex min-w-0 flex-1 flex-col items-start">
                        <span className="w-full truncate">{item.name}</span>
                        <span className="text-[11px] leading-tight text-muted-foreground">
                          {item.type === 'creator_space'
                            ? t('organization.account.personalSubtitle')
                            : t('organization.account.enterpriseSubtitle', {
                              role: t(`organization.role.${item.membership.role}`),
                            })}
                        </span>
                      </span>
                      {selected ? <Check className="size-3.5 shrink-0" /> : null}
                    </StyledDropdownMenuItem>
                  )
                })}
                <StyledDropdownMenuSeparator />
                {active?.type === 'creator_space' && (
                  <StyledDropdownMenuItem onClick={organization.onManageOrganization}>
                    <Package className="size-3.5" />
                    {t('creatorSkills.artifacts.title')}
                  </StyledDropdownMenuItem>
                )}
                {canManage && (
                  <StyledDropdownMenuItem onClick={organization.onManageOrganization}>
                    <Settings2 className="size-3.5" />
                    {t('organization.manage.title')}
                  </StyledDropdownMenuItem>
                )}
                <StyledDropdownMenuItem onClick={organization.onCreateOrganization}>
                  <Building2 className="size-3.5" />
                  {t('organization.createAnother')}
                </StyledDropdownMenuItem>
              </StyledDropdownMenuSubContent>
            </DropdownMenuSub>
          </div>
        )}

        <div className={cn(organization && 'border-t border-border', 'p-1')}>
          <StyledDropdownMenuItem onClick={onOpenSettings}>
            <Settings2 className="size-3.5" />
            <span className="flex min-w-0 flex-1 flex-col items-start">
              <span className="text-[13px] leading-tight">{t('organization.account.settings')}</span>
              <span className="text-[11px] leading-tight text-muted-foreground">
                {t('organization.account.settingsSubtitle')}
              </span>
            </span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          </StyledDropdownMenuItem>
        </div>

        <div className="border-t border-border p-1">
          <StyledDropdownMenuItem
            data-testid="account-menu-logout"
            variant="destructive"
            onClick={() => { void onLogout() }}
          >
            <LogOut className="size-3.5" />
            {t('sidebar.userMenu.logout')}
          </StyledDropdownMenuItem>
        </div>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
