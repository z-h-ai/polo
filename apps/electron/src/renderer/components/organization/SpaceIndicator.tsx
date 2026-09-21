import { Building2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useOptionalOrganizationContext } from '@/context/OrganizationContext'
import { cn } from '@/lib/utils'

/**
 * SpaceIndicator - Passive current-space display in the top bar (prototype R9).
 *
 * The top bar always shows which space is active but offers no dropdown here;
 * switching spaces happens only through the account menu's 「切换空间」 entry.
 */
export function SpaceIndicator({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const organization = useOptionalOrganizationContext()
  if (!organization) return null

  const active = organization.organizationSummaries.find(
    item => item.id === organization.activeOrganizationId,
  )
  if (!active) return null

  const ActiveIcon = active.type === 'creator_space' ? Sparkles : Building2

  return (
    <div
      data-testid="organization-space-indicator"
      aria-label={t('organization.account.currentSpaceAria', { name: active.name })}
      className={cn(
        'flex h-[28px] shrink-0 items-center gap-1.5 rounded-lg px-2',
        'text-sm text-foreground/80',
      )}
    >
      <ActiveIcon className="size-3.5 shrink-0 text-accent" />
      {!compact && <span className="max-w-52 truncate">{active.name}</span>}
    </div>
  )
}
