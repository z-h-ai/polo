import { useMemo, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { navigate } from '../runtime/state.js'

// Direct translation of ResetConfirmationDialog.tsx. The operands are generated
// exactly as in the Renderer (10..59) for each mounted dialog.
export function SourceResetConfirmation() {
  const [answer, setAnswer] = useState('')
  const problem = useMemo(() => {
    const a = Math.floor(Math.random() * 50) + 10
    const b = Math.floor(Math.random() * 50) + 10
    return { a, b, sum: a + b }
  }, [])
  const isCorrect = parseInt(answer, 10) === problem.sum
  const close = () => navigate({ scene: 'home' })
  return <div data-route="dialog/reset-confirmation" style={{ position: 'relative', display: 'grid', width: '100%', height: '100%', minHeight: 0, placeItems: 'center', background: 'color-mix(in srgb, #000 35%, transparent)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="reset-title" style={{ position: 'relative', width: 'calc(100% - 32px)', maxWidth: 448, boxSizing: 'border-box', padding: 24, border: '1px solid color-mix(in srgb, var(--border) 75%, transparent)', borderRadius: 10, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-modal, 0 16px 60px rgba(0,0,0,.22))' }}>
      <button type="button" onClick={close} aria-label="Close" style={{ position: 'absolute', top: 12, right: 12, display: 'grid', width: 28, height: 28, padding: 0, placeItems: 'center', border: 0, borderRadius: 6, color: 'var(--muted-foreground)', background: 'transparent' }}><X size={16}/></button>
      <header><h1 id="reset-title" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, color: 'var(--destructive, #dc2626)', fontSize: 18, fontWeight: 600 }}><AlertTriangle size={20}/>Reset App</h1><p style={{ margin: '16px 0 0', color: 'var(--muted-foreground)', fontSize: 14, lineHeight: 1.5 }}>This will <strong style={{ color: 'var(--foreground)' }}>permanently delete</strong>:</p></header>
      <ul style={{ margin: '14px 0 0', paddingLeft: 22, color: 'var(--muted-foreground)', fontSize: 14, lineHeight: 1.5 }}><li>All workspaces and their settings</li><li>All credentials and API keys</li><li>All preferences and session data</li></ul>
      <div style={{ marginTop: 18, padding: 12, border: '1px solid color-mix(in srgb, #f59e0b 30%, transparent)', borderRadius: 6, color: 'var(--muted-foreground)', background: 'color-mix(in srgb, #f59e0b 10%, transparent)', fontSize: 14, lineHeight: 1.45 }}><strong style={{ color: '#b45309' }}>Back up any important data first!</strong><p style={{ margin: '4px 0 0' }}>This action cannot be undone.</p></div>
      <div style={{ display: 'grid', gap: 8, marginTop: 18 }}><label htmlFor="reset-answer" style={{ fontSize: 14, fontWeight: 500 }}>To confirm, solve: {problem.a} + {problem.b} =</label><input id="reset-answer" type="text" inputMode="numeric" pattern="[0-9]*" value={answer} placeholder="Enter answer" onChange={event => setAnswer(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && isCorrect) close() }} style={{ width: 128, height: 36, boxSizing: 'border-box', padding: '0 12px', border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)', borderRadius: 6, outline: 0, color: 'var(--foreground)', background: 'var(--background)', fontSize: 14 }}/></div>
      <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24 }}><button type="button" onClick={close} style={outlineButton}>Cancel</button><button type="button" disabled={!isCorrect} onClick={close} style={{ ...destructiveButton, opacity: isCorrect ? 1 : .5 }}>Reset App</button></footer>
    </section>
  </div>
}
const outlineButton = { height: 36, padding: '0 14px', border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)', borderRadius: 6, color: 'var(--foreground)', background: 'var(--background)', fontSize: 14, fontWeight: 500 }
const destructiveButton = { height: 36, padding: '0 14px', border: 0, borderRadius: 6, color: '#fff', background: 'var(--destructive, #dc2626)', fontSize: 14, fontWeight: 500 }
