import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { StateCard } from '@/components/hifi'

/**
 * The four honest home/directory states (POO-70 WS-HOME-APPS):
 * zero frequent, empty directory, load failed, offline cache.
 *
 * All four are purely presentational — callers pass translated copy so the
 * HomePage keeps using its existing catalog keys while demos and other
 * surfaces can supply their own.
 */

export interface ZeroFrequentStateProps {
  title: ReactNode
  description: ReactNode
  actionLabel: ReactNode
  onAction: () => void
}

/** 零常用：只引导去全部应用，不替用户挑选（D-PC-01）。 */
export function ZeroFrequentState({
  title,
  description,
  actionLabel,
  onAction,
}: ZeroFrequentStateProps) {
  return (
    <div
      data-testid="home-state-zero-frequent"
      className="flex justify-center py-4"
    >
      <StateCard
        icon={{ kind: 'accent' }}
        title={title}
        description={description}
        actions={(
          <Button type="button" variant="secondary" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        )}
      />
    </div>
  )
}

export interface EmptyDirectoryStateProps {
  title: ReactNode
  description: ReactNode
  eyebrow?: ReactNode
}

/** 真空目录：诚实空态，说明何时会出现内容。 */
export function EmptyDirectoryState({
  title,
  description,
  eyebrow,
}: EmptyDirectoryStateProps) {
  return (
    <div
      data-testid="home-state-empty-directory"
      className="flex justify-center py-4"
    >
      <StateCard
        eyebrow={eyebrow}
        icon={{ kind: 'info' }}
        title={title}
        description={description}
      />
    </div>
  )
}

export interface DirectoryLoadFailedStateProps {
  title: ReactNode
  description: ReactNode
  retryLabel: ReactNode
  onRetry: () => void
}

/** 目录加载失败：可重试，不阻塞首页其它区域（C-R01）。 */
export function DirectoryLoadFailedState({
  title,
  description,
  retryLabel,
  onRetry,
}: DirectoryLoadFailedStateProps) {
  return (
    <div
      data-testid="home-state-load-failed"
      className="flex justify-center py-4"
    >
      <StateCard
        icon={{ kind: 'destructive' }}
        title={title}
        description={description}
        actions={(
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRetry}
          >
            {retryLabel}
          </Button>
        )}
      />
    </div>
  )
}

export interface OfflineDirectoryStateProps {
  description: ReactNode
  fetchedAtLine: ReactNode
}

/** 离线：展示缓存目录并标注获取时间（C-R07）。 */
export function OfflineDirectoryState({
  description,
  fetchedAtLine,
}: OfflineDirectoryStateProps) {
  return (
    <div
      data-testid="home-state-offline"
      className="flex justify-center py-4"
    >
      <StateCard
        icon={{ kind: 'info' }}
        title={fetchedAtLine}
        description={description}
      />
    </div>
  )
}
