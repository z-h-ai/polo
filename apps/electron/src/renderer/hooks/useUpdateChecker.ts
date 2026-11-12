/**
 * Update Checker Hook
 *
 * Manages auto-update state for the Electron app.
 * - Listens for update availability broadcasts from main process
 * - Tracks download progress
 * - Provides methods to check for updates and install
 * - Shows toast notification when update is ready
 * - Persistent dismissal across app restarts (per version)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { UpdateInfo } from '../../shared/types'

interface UseUpdateCheckerResult {
  /** Current update info */
  updateInfo: UpdateInfo | null
  /** Whether an update is available */
  updateAvailable: boolean
  /** Whether update is currently downloading */
  isDownloading: boolean
  /** Whether update is ready to install */
  isReadyToInstall: boolean
  /** Download progress (0-100) */
  downloadProgress: number
  /** Check for updates manually */
  checkForUpdates: () => Promise<void>
  /** Install the downloaded update and restart */
  installUpdate: () => Promise<void>
}

// Toast ID for update notification (allows dismiss/update)
const UPDATE_TOAST_ID = 'update-available'

/**
 * Errors whose message points at connectivity (electron-updater wraps DNS,
 * socket and HTTP failures in messages like "ENOTFOUND", "ECONNREFUSED",
 * "network", "timeout"...). Matched by substring on purpose: the updater's
 * wording varies across platforms, but these tokens are stable signals.
 */
const NETWORK_ERROR_RE = /network|offline|dns|socket|timeout|timed?\s*out|enotfound|econn(refused|reset|aborted)|eai_again|err_internet|fetch failed|status code\s*5\d\d/i

export type UpdateFailureAction = 'check' | 'install'

export interface UpdateFailureCopy {
  /** Toast title key. */
  titleKey: string
  /** Toast description key — the "what to do next" guidance. */
  descKey: string
  /** True when the failure looks connectivity-related. */
  isNetwork: boolean
}

/**
 * Map an update failure to friendly, pre-localized copy keys.
 *
 * Known-shape (network) errors get a targeted "check your connection" hint;
 * anything unknown degrades to a generic retry-later suggestion instead of
 * leaking the raw error text. The raw diagnostic stays in console.error.
 */
export function classifyUpdateFailure(error: unknown, action: UpdateFailureAction): UpdateFailureCopy {
  const msg = error instanceof Error ? error.message : String(error)
  const isNetwork = NETWORK_ERROR_RE.test(msg)
  if (isNetwork) {
    return {
      titleKey: action === 'check' ? 'toast.failedToCheckUpdates' : 'toast.failedToInstallUpdate',
      descKey: 'toast.updateNetworkFailedDesc',
      isNetwork,
    }
  }
  return {
    titleKey: action === 'check' ? 'toast.failedToCheckUpdates' : 'toast.failedToInstallUpdate',
    descKey: action === 'check' ? 'toast.updateCheckFailedDesc' : 'toast.updateInstallFailedDesc',
    isNetwork,
  }
}

export function useUpdateChecker(): UseUpdateCheckerResult {
  const { t } = useTranslation()
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  // Track if we've shown the toast for this version to avoid duplicates
  const shownToastVersionRef = useRef<string | null>(null)

  // Show toast notification when update is ready
  const showUpdateToast = useCallback((version: string, onInstall: () => void) => {
    // Don't show if already shown for this version in this session
    if (shownToastVersionRef.current === version) {
      return
    }
    shownToastVersionRef.current = version

    toast.info(t('toast.updateReady', { version }), {
      id: UPDATE_TOAST_ID,
      description: t('toast.restartToApply'),
      duration: 10000, // 10 seconds, then auto-dismiss
      action: {
        label: t('toast.restart'),
        onClick: onInstall,
      },
      onDismiss: () => {
        // Persist dismissal so we don't show again after app restart
        window.electronAPI.dismissUpdate(version)
      },
    })
  }, [t])

  // Install the update
  const installUpdate = useCallback(async () => {
    try {
      // Dismiss the update toast first
      toast.dismiss(UPDATE_TOAST_ID)
      toast.info(t('toast.installingUpdate'), {
        description: t('toast.appWillRestart'),
        duration: 5000,
      })
      await window.electronAPI.installUpdate()
    } catch (error) {
      // Friendly failure copy: what happened + what to do next. Raw detail stays in console.
      console.error('[useUpdateChecker] Install failed:', error)
      const copy = classifyUpdateFailure(error, 'install')
      toast.error(t(copy.titleKey), {
        description: t(copy.descKey),
      })
    }
  }, [t])

  // Load initial state and check if update ready
  useEffect(() => {
    const checkAndNotify = async (info: UpdateInfo) => {
      if (!info.available || !info.latestVersion) return
      if (info.downloadState !== 'ready') return

      // Check if this version was dismissed
      const dismissedVersion = await window.electronAPI.getDismissedUpdateVersion()
      if (dismissedVersion === info.latestVersion) {
        return
      }

      // Show toast for ready update
      showUpdateToast(info.latestVersion, installUpdate)
    }

    // Get initial update info
    window.electronAPI.getUpdateInfo().then((info) => {
      setUpdateInfo(info)
      checkAndNotify(info)
    })

    // Subscribe to update availability changes
    const cleanupAvailable = window.electronAPI.onUpdateAvailable((info) => {
      setUpdateInfo(info)
      checkAndNotify(info)
    })

    // Subscribe to download progress updates
    const cleanupProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
      setUpdateInfo((prev) => prev ? { ...prev, downloadProgress: progress } : prev)
    })

    return () => {
      cleanupAvailable()
      cleanupProgress()
    }
  }, [showUpdateToast, installUpdate])

  // Check for updates manually
  const checkForUpdates = useCallback(async () => {
    try {
      const info = await window.electronAPI.checkForUpdates()
      setUpdateInfo(info)

      if (!info.available) {
        toast.success(t('toast.upToDate'), {
          description: t('toast.versionIsLatest', { version: info.currentVersion }),
          duration: 3000,
        })
      } else if (info.downloadState === 'ready' && info.latestVersion) {
        // If already ready, show toast (clear any previous dismissal since user explicitly checked)
        shownToastVersionRef.current = null // Reset so toast can show again
        showUpdateToast(info.latestVersion, installUpdate)
      }
    } catch (error) {
      // Friendly failure copy: what happened + what to do next. Raw detail stays in console.
      console.error('[useUpdateChecker] Check failed:', error)
      const copy = classifyUpdateFailure(error, 'check')
      toast.error(t(copy.titleKey), {
        description: t(copy.descKey),
      })
    }
  }, [showUpdateToast, installUpdate])

  return {
    updateInfo,
    updateAvailable: updateInfo?.available ?? false,
    isDownloading: updateInfo?.downloadState === 'downloading',
    isReadyToInstall: updateInfo?.downloadState === 'ready',
    downloadProgress: updateInfo?.downloadProgress ?? 0,
    checkForUpdates,
    installUpdate,
  }
}
