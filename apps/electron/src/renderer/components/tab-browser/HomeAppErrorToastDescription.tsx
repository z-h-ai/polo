import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy } from 'lucide-react'
import type { HomeAppErrorPresentation } from '@/lib/home-app-errors'

/**
 * product-closure U5: toast description for home-app operation failures.
 * Regular errors render text only; infrastructure-side failures additionally
 * render the ACTUAL structured server code as a one-click copyable badge, so
 * "联系企业管理员" comes with the exact string the admin needs (POL-277
 * follow-up: the user used to have no way to report what actually failed).
 */
export function HomeAppErrorToastDescription({ presentation }: { presentation: HomeAppErrorPresentation }) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  if (!presentation.copyableCode) {
    return <>{presentation.text}</>
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(presentation.copyableCode ?? '')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error(t('infraError.copyFailed'))
    }
  }

  return (
    <span className="flex flex-col items-start gap-1.5">
      <span>{presentation.text}</span>
      <button
        type="button"
        data-testid="home-app-error-code-copy"
        onClick={(event) => {
          event.stopPropagation()
          void copyCode()
        }}
        className="inline-flex max-w-full items-center gap-1.5 rounded-[6px] border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground-70 outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
        title={t('infraError.copyErrorCode')}
        aria-label={t('infraError.copyErrorCode')}
      >
        <span className="min-w-0 truncate font-mono">{presentation.copyableCode}</span>
        {copied
          ? <Check className="h-3 w-3 shrink-0 text-success" aria-hidden="true" />
          : <Copy className="h-3 w-3 shrink-0" aria-hidden="true" />}
        <span className="shrink-0">{copied ? t('infraError.copied') : t('infraError.copyErrorCode')}</span>
      </button>
    </span>
  )
}
