/**
 * BatchAutomationMenu - Context menu content for batch operations on multi-selected automations.
 *
 * Self-contained component that uses hooks to access selection state, automation metadata,
 * and mutation callbacks. Renders polymorphic menu items via useMenuComponents() so it
 * works in both DropdownMenu and ContextMenu scenarios.
 *
 * Mirrors the BatchSessionMenu pattern with automation-specific actions:
 * Enable/Disable All and Delete.
 *
 * U3 (product-closure 2026-10-27): this component lives inside the context-menu
 * content, which Radix unmounts the moment an item is clicked — so the confirm
 * dialog and the batch execution itself CANNOT live here (they would unmount
 * mid-ask). The menu only reports the intent upward; the stable-mounted
 * AutomationsListPanel owns the confirm ask, the sequential execution and the
 * honest per-item counts.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { Power, PowerOff, Trash2 } from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { automationSelection } from '@/hooks/useEntitySelection'
import { automationsAtom } from '@/atoms/automations'
import { useAppShellContext } from '@/context/AppShellContext'

const {
  useSelectedIds: useAutomationSelectedIds,
} = automationSelection

export interface BatchAutomationMenuProps {
  /** U3: run the batch toggle on the current selection (panel-owned). */
  onBatchToggle?: () => void
  /** U3: ask the panel to confirm, then run the batch delete (panel-owned). */
  onBatchDelete?: () => void
}

export function BatchAutomationMenu({ onBatchToggle, onBatchDelete }: BatchAutomationMenuProps) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = useMenuComponents()

  const selectedIds = useAutomationSelectedIds()
  const automations = useAtomValue(automationsAtom)

  const {
    activeWorkspaceId,
  } = useAppShellContext()

  // Resolve selected automations metadata
  const selectedAutomations = useMemo(() => {
    return [...selectedIds]
      .map(id => automations.find(a => a.id === id))
      .filter((a): a is NonNullable<typeof a> => a != null)
  }, [selectedIds, automations])

  // Check if all selected are enabled
  const allEnabled = useMemo(() => {
    return selectedAutomations.length > 0 && selectedAutomations.every(a => a.enabled)
  }, [selectedAutomations])

  const count = selectedIds.size

  return (
    <>
      {/* Header showing selection count */}
      <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">
        {t('automations.batchSelected', { count })}
      </div>
      <Separator />

      {/* Enable/Disable All */}
      <MenuItem onClick={onBatchToggle}>
        {allEnabled ? (
          <PowerOff className="h-3.5 w-3.5" />
        ) : (
          <Power className="h-3.5 w-3.5" />
        )}
        <span className="flex-1">{allEnabled ? t('automations.menuDisableAll') : t('automations.menuEnableAll')}</span>
      </MenuItem>

      <Separator />

      {/* Delete */}
      {activeWorkspaceId && (
        <MenuItem onClick={onBatchDelete} variant="destructive">
          <Trash2 className="h-3.5 w-3.5" />
          <span className="flex-1">{t('automations.menuDelete')}</span>
        </MenuItem>
      )}
    </>
  )
}
