import { X } from 'lucide-react'
import { navigate } from '../runtime/state.js'

// Exact action definitions from renderer/actions/definitions.ts, rendered with
// macOS hotkey display because this Electron capture target is macOS.
const registry = [
  ['General', [['New Chat','⌘','N'],['New Chat in Panel','⌘','T'],['Settings','⌘',','],['Toggle Theme','⌘','⇧','A'],['Search','⌘','F'],['Keyboard Shortcuts','⌘','/'],['New Window','⌘','⇧','N'],['Quit','⌘','Q']]],
  ['Navigation', [['Focus Sidebar','⌘','1'],['Focus Navigator','⌘','2'],['Focus Chat','⌘','3'],['Focus Next Zone','Tab'],['Go Back','⌘','['],['Go Forward','⌘',']'],['Go Back','⌘','←'],['Go Forward','⌘','→'],['Focus Next Panel','⌘','⇧',']'],['Focus Previous Panel','⌘','⇧','[']]],
  ['View', [['Toggle Sidebar','⌘','B'],['Toggle Focus Mode','⌘','.']]],
  ['Navigator', [['Select All','⌘','A'],['Clear Selection','Esc']]],
  ['Chat', [['Stop Processing','Esc'],['Cycle Permission Mode','⇧','Tab'],['Next Search Match','⌘','G'],['Previous Search Match','⌘','⇧','G']]],
]
const contextual = [
  ['List Navigation', [['Navigate items in list','↑','↓'],['Go to first item','Home'],['Go to last item','End']]],
  ['Session List', [['Focus chat input','Enter'],['Delete session','Delete'],['Rename session','R'],['Open context menu','Right-click'],['Add filter as excluded','⌥','Click']]],
  ['Agent Tree', [['Collapse folder','←'],['Expand folder','→']]],
  ['Chat Input', [['Send message','Enter'],['New line','Shift','Enter'],['Close dialog / blur input','Esc']]],
]

// KeyboardShortcutsDialog.tsx's 500px, 80vh scrollable DialogContent.
export function SourceKeyboardShortcutsDialog() {
  const close = () => navigate({ scene: 'home' })
  return <div data-route="dialog/keyboard-shortcuts" style={{ display: 'grid', width: '100%', height: '100%', minHeight: 0, placeItems: 'center', background: 'color-mix(in srgb, #000 35%, transparent)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" style={{ position: 'relative', width: 'calc(100% - 32px)', maxWidth: 500, maxHeight: '80vh', boxSizing: 'border-box', overflowY: 'auto', padding: 24, border: '1px solid color-mix(in srgb, var(--border) 75%, transparent)', borderRadius: 10, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-modal, 0 16px 60px rgba(0,0,0,.22))' }}>
      <button type="button" onClick={close} aria-label="Close" style={{ position: 'absolute', top: 12, right: 12, display: 'grid', width: 28, height: 28, padding: 0, placeItems: 'center', border: 0, borderRadius: 6, color: 'var(--muted-foreground)', background: 'transparent' }}><X size={16}/></button>
      <h1 id="shortcuts-title" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Keyboard Shortcuts</h1>
      <div style={{ display: 'grid', gap: 24, padding: '16px 0 8px' }}>{[...registry, ...contextual].map(([title, rows]) => <ShortcutSection key={title} title={title} rows={rows}/>)}</div>
    </section>
  </div>
}
function ShortcutSection({ title, rows }) { return <section><h3 style={{ margin: '0 0 8px', color: 'var(--muted-foreground)', fontSize: 12, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase' }}>{title}</h3><div style={{ display: 'grid', gap: 6 }}>{rows.map(([label, ...keys], i) => <div key={title + i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 20, padding: '4px 0' }}><span style={{ fontSize: 14 }}>{label}</span><span style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 4 }}>{keys.map((key, index) => <kbd key={index} style={{ display: 'inline-flex', minWidth: 20, height: 20, boxSizing: 'border-box', alignItems: 'center', justifyContent: 'center', padding: '0 6px', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--foreground)', background: 'var(--muted, #f4f4f5)', boxShadow: '0 1px 1px rgba(0,0,0,.06)', fontFamily: 'inherit', fontSize: 11, fontWeight: 500 }}>{key}</kbd>)}</span></div>)}</div></section> }
