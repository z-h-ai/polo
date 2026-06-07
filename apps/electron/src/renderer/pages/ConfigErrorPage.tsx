import React from 'react'

export interface ConfigErrorPageProps {
  isRetrying?: boolean
  onRetry: () => void
}

function RetrySpinner() {
  return (
    <svg
      aria-hidden="true"
      data-testid="config-error-retry-spinner"
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

export default function ConfigErrorPage({
  isRetrying = false,
  onRetry,
}: ConfigErrorPageProps) {
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <section className="w-full max-w-md space-y-6 text-center">
        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground/60">Model configuration</p>
          <h1 className="text-2xl font-semibold">配置加载失败</h1>
          <p role="alert" className="text-sm leading-6 text-foreground/70">
            登录成功，但未能加载 LLM 配置。请检查网络或稍后重试。
          </p>
        </div>

        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          aria-busy={isRetrying}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {isRetrying && <RetrySpinner />}
          {isRetrying ? '正在重试...' : '重试'}
        </button>
      </section>
    </main>
  )
}
