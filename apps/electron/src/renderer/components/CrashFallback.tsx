import { useTranslation } from 'react-i18next'

/**
 * Minimal fallback UI shown when the entire React tree crashes.
 * Sentry.ErrorBoundary captures the error and sends it to Sentry automatically.
 *
 * POO-179: extracted verbatim from main.tsx (same markup, same reload callback,
 * same Sentry boundary — main.tsx still mounts it in the identical position) so
 * the self-produced template can be localized and the real component can be
 * mounted in isolation. The original crash diagnostics are reported to Sentry,
 * never rendered here.
 */
export function CrashFallback() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <p className="text-base font-medium">{t('errors.crash.title')}</p>
      <p className="text-[13px]">{t('errors.crash.description')}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-2 px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
      >
        {t('common.reload')}
      </button>
    </div>
  )
}
