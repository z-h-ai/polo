import * as React from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export function NoLlmConfigBanner({
  className,
}: {
  className?: string
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 rounded-md border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/70',
        className,
      )}
    >
      <AlertCircle className="h-4 w-4 shrink-0 text-foreground/50" />
      <span>暂无可用的 LLM 配置，请联系管理员</span>
    </div>
  )
}
