/**
 * EmptySessionGuidance - "What can I do" guidance for a brand-new session
 *
 * The desktop empty session renders no content of its own, so the message
 * area shows a short invitation plus three example prompts — a curated,
 * capability-diverse subset of the EmptyStateHint templates (source
 * workflow, file workflow, folder workflow).
 *
 * A click fills the composer through the existing craft:insert-text channel:
 * FreeFormInput owns the draft and the focus, so guidance never bypasses the
 * real input path.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getHintPlainText } from './EmptyStateHint'

const GUIDANCE_HINT_KEYS = [
  'hints.summarizeGmail',
  'hints.screenshotToWebsite',
  'hints.refactorCode',
]

export interface EmptySessionGuidanceProps {
  /** Session the composer belongs to (scopes craft:insert-text to it) */
  sessionId?: string
  className?: string
}

export function EmptySessionGuidance({ sessionId, className }: EmptySessionGuidanceProps) {
  const { t } = useTranslation()

  const hintTexts = React.useMemo(
    () => GUIDANCE_HINT_KEYS.map(key => getHintPlainText(t, key)),
    [t],
  )

  const handleHintClick = React.useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent('craft:insert-text', {
      detail: { text, sessionId },
    }))
  }, [sessionId])

  return (
    <div
      data-testid="empty-session-guidance"
      className={cn(
        'flex w-full max-w-[520px] flex-col items-center gap-3 select-none',
        className,
      )}
    >
      <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em] text-foreground">
        {t('chatInput.placeholder.workOn')}
      </h2>
      <p className="m-0 text-center text-[13px] leading-[1.6] text-muted-foreground">
        {t('chat.emptySession.tryHint')}
      </p>
      <div className="mt-1 flex w-full flex-col gap-[10px]">
        {hintTexts.map(text => (
          <button
            key={text}
            type="button"
            data-testid="empty-session-guidance-hint"
            onClick={() => handleHintClick(text)}
            className="inline-flex min-h-[44px] w-full items-center gap-[8px] rounded-[10px] border border-border bg-foreground-5 px-[14px] text-left text-[13px] font-medium text-foreground transition-colors hover:bg-foreground-10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            <Sparkles className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
