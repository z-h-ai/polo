import React from 'react'

export interface SessionExpiredDialogProps {
  visible: boolean
  onLogin: () => void
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function trapTabFocus(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return

  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true')

  if (focusable.length === 0) {
    event.preventDefault()
    event.currentTarget.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const target = event.target

  if (event.shiftKey && target === first) {
    event.preventDefault()
    last.focus()
    return
  }

  if (!event.shiftKey && target === last) {
    event.preventDefault()
    first.focus()
  }
}

export default function SessionExpiredDialog({
  visible,
  onLogin,
}: SessionExpiredDialogProps) {
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="会话已失效"
        tabIndex={-1}
        autoFocus
        onKeyDown={trapTabFocus}
        className="w-full max-w-sm rounded-md border border-foreground/10 bg-background p-6 text-center text-foreground shadow-xl"
      >
        <h2 className="text-lg font-semibold">会话已失效</h2>
        <p className="mt-3 text-sm leading-6 text-foreground/70">会话已失效，请重新登录</p>
        <button
          type="button"
          onClick={onLogin}
          className="mt-6 inline-flex h-10 items-center justify-center rounded-md bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          重新登录
        </button>
      </div>
    </div>
  )
}
