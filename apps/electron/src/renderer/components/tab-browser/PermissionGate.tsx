import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * 准备与权限确认 + OS 权限被拒（P-M04-PREPARE / PREP-FAILED / PERM-DENIED）。
 *
 * - prepare：权限说明 + 下载进度 + 确认打开，可取消（复用安装对话框结构）；
 * - failed：加载失败不影响已装版本，可重试可先用当前版本（C-R02）；
 * - os-denied：OS 拒绝 → 系统设置路径；只有用户主动点「重试请求」才会
 *   再次请求，不自动反复请求（C-R06）。
 */

export type PermissionGatePhase = 'prepare' | 'failed' | 'os-denied'

interface PermissionGateProps {
  open: boolean
  phase: PermissionGatePhase
  appName: string
  requestedPermissions: string[]
  /** 发布版本（prepare 态展示下载进度时使用）。 */
  version?: string
  /** 0-100；undefined 表示进度不可用（仅权限确认）。 */
  progressPercent?: number
  /** prepare：不允许（取消）。 */
  onDeny: () => void
  /** prepare：允许本次访问。 */
  onAllow: () => void
  /** failed：重新加载。 */
  onRetryReload: () => void
  /** failed：先用当前已安装版本。 */
  onUseCurrentVersion?: () => void
  /** os-denied：打开系统设置。 */
  onOpenSystemSettings: () => void
  /** os-denied：用户主动重试请求。 */
  onRetryRequest: () => void
  /** os-denied：稍后再说。 */
  onLater?: () => void
}

export function PermissionGate({
  open,
  phase,
  appName,
  requestedPermissions,
  version,
  progressPercent,
  onDeny,
  onAllow,
  onRetryReload,
  onUseCurrentVersion,
  onOpenSystemSettings,
  onRetryRequest,
  onLater,
}: PermissionGateProps) {
  const { t } = useTranslation()

  const permissionList = requestedPermissions.length > 0 ? (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('appContainer.permission.permissionsLabel')}
      </p>
      <ul className="mt-2 space-y-1.5">
        {requestedPermissions.map(permission => (
          <li key={permission} className="flex items-start gap-2 text-sm">
            <Icons.ShieldCheck
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.5}
            />
            <span>{permission}</span>
          </li>
        ))}
      </ul>
    </div>
  ) : null

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) {
        if (phase === 'prepare') onDeny()
        else if (phase === 'failed') onUseCurrentVersion?.()
        else onLater?.()
      }
    }}>
      <DialogContent data-testid="permission-gate">
        {phase === 'prepare' && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('appContainer.permission.prepareTitle', { name: appName })}
              </DialogTitle>
              <DialogDescription>
                {t('appContainer.permission.prepareDescription')}
              </DialogDescription>
            </DialogHeader>
            {permissionList}
            {progressPercent != null && (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Icons.LoaderCircle
                    className="size-3.5 animate-spin"
                    strokeWidth={1.5}
                  />
                  {t('appContainer.permission.downloading', {
                    version: version ?? '',
                    percent: Math.round(progressPercent),
                  })}
                </p>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progressPercent)}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/8"
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onDeny}>
                {t('appContainer.permission.deny')}
              </Button>
              <Button type="button" onClick={onAllow}>
                {t('appContainer.permission.allow')}
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === 'failed' && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('appContainer.permission.failedTitle', { name: appName })}
              </DialogTitle>
              <DialogDescription>
                {t('appContainer.permission.failedDescription')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
              <Button type="button" variant="secondary" onClick={onRetryReload}>
                <Icons.RefreshCw className="size-4" strokeWidth={1.5} />
                {t('appContainer.permission.retry')}
              </Button>
              {onUseCurrentVersion && (
                <Button type="button" onClick={onUseCurrentVersion}>
                  {t('appContainer.permission.useCurrent')}
                </Button>
              )}
            </DialogFooter>
          </>
        )}

        {phase === 'os-denied' && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('appContainer.permission.osDeniedTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('appContainer.permission.osDeniedDescription', {
                  name: appName,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
              <Button type="button" onClick={onOpenSystemSettings}>
                <Icons.Settings className="size-4" strokeWidth={1.5} />
                {t('appContainer.permission.openSettings')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={onRetryRequest}
              >
                {t('appContainer.permission.retryRequest')}
              </Button>
              {onLater && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onLater}
                >
                  {t('appContainer.permission.later')}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
