/**
 * FileMissingState — a session/conversation file whose original has moved or
 * been deleted (POO-70 M08, C-R02). The row keeps the file name, states the
 * missing reason, and offers the re-pick path so the work is recoverable
 * instead of silently dropped.
 */

import { FileWarning } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export interface FileMissingStateProps {
  fileName: string
  /** 重选路径 — lets the user point back at the moved file. */
  onRepick: () => void
  className?: string
}

export function FileMissingState({ fileName, onRepick, className }: FileMissingStateProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="file-missing-state"
      className={cn(
        'flex flex-wrap items-center gap-2.5 rounded-sm border border-destructive/30 bg-destructive/5 px-2.5 py-2',
        className,
      )}
    >
      <FileWarning className="size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-[13px] font-medium text-foreground">{fileName}</p>
        <p className="m-0 text-[11px] leading-tight text-muted-foreground">
          {t('files.missing.reason')}
        </p>
      </div>
      <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={onRepick}>
        {t('files.missing.repick')}
      </Button>
    </div>
  )
}
