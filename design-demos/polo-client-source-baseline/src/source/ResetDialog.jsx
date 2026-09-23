import { useMemo, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { navigate } from '../runtime/state.js'

// Direct translation of ResetConfirmationDialog.tsx onto the dialog.tsx
// skeleton: popover-styled content (radius 8, no border, shadow-modal-small,
// gap-4 p-6), sm:max-w-md = 432px at the 15px root, close button top-4
// right-4 rounded-xs opacity-70. Copy is zh-Hans from zh-Hans.json
// (dialog.reset.*). The math operands are generated exactly as in the
// Renderer (10..59).
export function SourceResetConfirmation() {
  const [answer, setAnswer] = useState('')
  const problem = useMemo(() => {
    const a = Math.floor(Math.random() * 50) + 10
    const b = Math.floor(Math.random() * 50) + 10
    return { a, b, sum: a + b }
  }, [])
  const isCorrect = parseInt(answer, 10) === problem.sum
  const close = () => navigate({ scene: 'home' })
  return <div data-route="dialog/reset-confirmation" style={{ position: 'relative', display: 'grid', width: '100%', height: '100%', minHeight: 0, placeItems: 'center', background: 'rgba(0,0,0,.5)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="reset-title" style={{ position: 'relative', display: 'grid', width: 'calc(100% - 32px)', maxWidth: 432, boxSizing: 'border-box', gap: 15, padding: 22.5, borderRadius: 8, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-modal-small)' }}>
      <button type="button" onClick={close} aria-label="Close" style={{ position: 'absolute', top: 15, right: 15, display: 'grid', width: 15, height: 15, padding: 0, placeItems: 'center', border: 0, borderRadius: 2, color: 'var(--foreground)', background: 'transparent', opacity: .7 }}><X size={15}/></button>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 7.5 }}>
        <h1 id="reset-title" style={{ display: 'flex', alignItems: 'center', gap: 7.5, margin: 0, color: 'var(--destructive)', fontSize: 16.875, fontWeight: 600, lineHeight: 1 }}><AlertTriangle size={18.75}/>重置应用</h1>
        {/* DialogDescription text-left pt-2, text-sm muted with a <strong>. */}
        <p style={{ margin: '7.5px 0 0', color: 'var(--fg-50)', fontSize: 13.125, lineHeight: 1.375 }}>这将<strong style={{ color: 'var(--foreground)' }}>永久删除</strong>:</p>
      </header>
      {/* list-disc list-inside pl-2 space-y-1. */}
      <ul style={{ margin: 0, padding: 0, paddingLeft: 7.5, listStyle: 'disc inside', color: 'var(--fg-50)', fontSize: 13.125, lineHeight: 1.375, display: 'grid', gap: 3.75 }}><li>所有 Workspace 及其设置</li><li>所有凭证和 API 密钥</li><li>所有偏好设置和会话数据</li></ul>
      <div style={{ padding: 11.25, border: '1px solid color-mix(in srgb, var(--amber-strong) 30%, transparent)', borderRadius: 5.625, fontSize: 13.125, background: 'color-mix(in srgb, var(--amber-strong) 10%, transparent)' }}><strong style={{ color: 'var(--amber-strong)' }}>请先备份重要数据!</strong><p style={{ margin: '3.75px 0 0', color: 'var(--fg-50)' }}>此操作不可撤销。</p></div>
      <div style={{ display: 'grid', gap: 7.5, paddingTop: 7.5 }}>
        <label htmlFor="reset-answer" style={{ fontSize: 13.125, fontWeight: 500, lineHeight: 1.375 }}>确认请解答: {problem.a} + {problem.b} =</label>
        <input id="reset-answer" type="text" inputMode="numeric" pattern="[0-9]*" value={answer} placeholder="输入答案" onChange={event => setAnswer(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && isCorrect) close() }} style={{ width: 120, height: 33.75, boxSizing: 'border-box', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, outline: 0, color: 'var(--foreground)', background: 'var(--background)', fontSize: 13.125 }}/>
      </div>
      {/* DialogFooter: flex-col-reverse gap-2 sm:flex-row sm:justify-end with
          gap-2 sm:gap-0 — the desktop row has no gap between buttons. */}
      <footer style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end' }}>
        <button type="button" onClick={close} style={outlineButton}>取消</button>
        <button type="button" disabled={!isCorrect} onClick={close} style={{ ...destructiveButton, opacity: isCorrect ? 1 : .5 }}>重置应用</button>
      </footer>
    </section>
  </div>
}
// button.tsx defaults: outline h-9 px-4 border-foreground/15, destructive
// h-9 px-4 text-destructive-foreground (= var(--background)). fg15 must be
// declared before the style constants that interpolate it (module-level
// const initializers run in order).
const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'
const outlineButton = { display: 'inline-flex', height: 33.75, alignItems: 'center', padding: '0 15px', border: `1px solid ${fg15}`, borderRadius: 5.625, color: 'var(--foreground)', background: 'var(--background)', fontSize: 13.125, fontWeight: 500 }
const destructiveButton = { display: 'inline-flex', height: 33.75, alignItems: 'center', padding: '0 15px', border: 0, borderRadius: 5.625, color: 'var(--background)', background: 'var(--destructive)', fontSize: 13.125, fontWeight: 500 }
