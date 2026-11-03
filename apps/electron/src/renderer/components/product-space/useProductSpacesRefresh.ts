import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

/**
 * X2-11: the two user-initiated「刷新项目」entries (the account/space menu
 * and the select screen) share one wrapper so a re-read never fails silently.
 * `onRefreshProductSpaces` resolving to `null` is the provider's FAILED
 * re-read (context contract), indistinguishable from "no new projects" unless
 * the UI says so — a menu item that just closes with no answer reads as a
 * broken button. Progress is a loading toast because both entries dismiss
 * their host surface on click; a failure turns into an in-place retry. Success
 * stays quiet: a changed list announces itself.
 */
export function useProductSpacesRefresh() {
  const { t } = useTranslation()
  const [refreshing, setRefreshing] = useState(false)
  // Refs, not state, for the re-entrancy guard and the retry runner: a
  // callback identity that depends on `refreshing` would make the toast's
  // retry action capture a stale guard and silently no-op.
  const refreshingRef = useRef(false)
  const runnerRef = useRef<(() => unknown) | null>(null)

  const refreshProductSpaces = useCallback(async (run: () => unknown): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    runnerRef.current = run
    setRefreshing(true)
    const toastId = toast.loading(t('createProject.refreshing'))
    try {
      const result = await run()
      if (result === null || result === undefined) {
        toast.error(t('createProject.refreshFailed'), {
          id: toastId,
          action: {
            label: t('common.retry'),
            onClick: () => {
              const retry = runnerRef.current
              if (retry) void refreshProductSpaces(retry)
            },
          },
        })
        return
      }
      toast.dismiss(toastId)
    } catch {
      toast.error(t('createProject.refreshFailed'), { id: toastId })
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [t])

  return { refreshing, refreshProductSpaces }
}
