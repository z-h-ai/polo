import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * POO-207: the ENTERPRISE project tab's sidebar collapse DEFAULT.
 *
 * Entering a project tab collapses the left sidebar: the tab's sidebar is
 * only the re-skinned conversation filter (POO-205 C8 R7) and everything it
 * shows is already in the adjacent navigator strip, so the tab starts with
 * the sidebar closed. The collapse is a TAB-SCOPED OVERRIDE — `null` means
 * "no override, follow the persisted workspace preference" — so the user's
 * workspace-wide `sidebarVisible` choice is never rewritten by merely
 * visiting a project, and a manual toggle while the tab hosts the shell
 * writes this override instead.
 *
 * Re-entering a project (switching to another project tab included) collapses
 * again; landing on any non-project tab (home / polo / personal chat) clears
 * the override and hands the pre-entry visibility back.
 *
 * Returns `[override, setOverride]` — the caller derives the effective
 * visibility as `override ?? persistedVisible` and keeps the persist effect
 * on the persisted value only.
 */
export function useProjectTabSidebarCollapse(
  isEnterpriseProjectTab: boolean,
  projectTabId: string | null,
): [boolean | null, Dispatch<SetStateAction<boolean | null>>] {
  const [override, setOverride] = useState<boolean | null>(null)

  useEffect(() => {
    // Bail-out on an unchanged `false` keeps project→project switches from
    // resurrecting the sidebar the user may have closed on the previous one.
    setOverride(isEnterpriseProjectTab ? false : null)
  }, [isEnterpriseProjectTab, projectTabId])

  return [override, setOverride]
}
