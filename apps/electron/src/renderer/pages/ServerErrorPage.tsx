import React from 'react'

export interface ServerErrorPageProps {
  serverUrl?: string
  isRetrying?: boolean
  onRetry: () => void
}

function RetrySpinner({ testId }: { testId: string }) {
  return (
    <svg
      aria-hidden="true"
      data-testid={testId}
      className="size-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function getDefaultAdminServerUrl(): string {
  const env = (import.meta as ImportMeta & {
    env?: Record<string, string | undefined>
  }).env

  return env?.POLO_ADMIN_API_URL ?? env?.VITE_POLO_ADMIN_API_URL ?? 'POLO_ADMIN_API_URL 未配置'
}

export default function ServerErrorPage({
  serverUrl = getDefaultAdminServerUrl(),
  isRetrying = false,
  onRetry,
}: ServerErrorPageProps) {
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <section className="w-full max-w-md space-y-6 text-center">
        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground/60">Authentication server</p>
          <h1 className="text-2xl font-semibold">无法连接到认证服务器</h1>
          <p role="alert" className="text-sm leading-6 text-foreground/70">
            请确认认证服务器可访问，然后重试启动验证。
          </p>
        </div>

        <div className="rounded-md border border-foreground/10 bg-foreground/[0.03] px-4 py-3 text-left">
          <p className="text-xs font-medium uppercase text-foreground/45">POLO_ADMIN_API_URL</p>
          <p className="mt-1 break-all font-mono text-sm text-foreground/80">{serverUrl}</p>
        </div>

        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          aria-busy={isRetrying}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {isRetrying && <RetrySpinner testId="server-error-retry-spinner" />}
          {isRetrying ? '正在重试...' : '重试'}
        </button>
      </section>
    </main>
  )
}
