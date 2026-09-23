import { useState } from 'react'
import { ChevronDown, Globe, House, RotateCw } from 'lucide-react'
import { SourceBrowserEmptyState } from './BrowserEmptyState.jsx'

// Browser scene assembled from BrowserControls.tsx (toolbar), BrowserTabStrip
// + BrowserTabBadge.tsx (tab strip) and the BrowserEmptyState body. The strip
// fixture carries one deterministic webapp tab (a static review value, not a
// runtime page); the URL field shows its about:blank-style pending state and
// the toolbar keeps every control in its disabled/loading-idle branch —
// no BrowserView or remote page is instantiated.
export function SourceBrowserRegion({ state }) {
  if (state === 'toolbar') return <SourceBrowserToolbar />
  return <SourceBrowserTabStrip />
}

// packages/ui BrowserControls: h-[48px] border-b border-foreground/6 px-3
// row — nav cluster (three h-7 w-7 rounded-[6px] NavButtons), centered URL
// field (h-[30px] rounded-[8px] pl-8 text-[13px] with a Globe icon), right
// action cluster. Not loading: the X stop button is absent and there is no
// progress bar.
function SourceBrowserToolbar() {
  const [url, setUrl] = useState('')
  const navButton = { display: 'inline-flex', width: 26.25, height: 26.25, alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: 0, borderRadius: 4.5, background: 'transparent', color: 'var(--foreground)', opacity: 1 }
  const disabledNavButton = { ...navButton, opacity: .3 }
  return <div data-route="browser/toolbar" style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, flexDirection: 'column', background: 'var(--background)', color: 'var(--foreground)' }}>
    <div style={{ display: 'flex', height: 36, flexShrink: 0, alignItems: 'center', gap: 11.25, boxSizing: 'border-box', padding: '0 11.25px', borderBottom: `1px solid color-mix(in srgb, var(--foreground) 6%, transparent)` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <button type="button" aria-label="后退" disabled style={disabledNavButton}><ChevronLeftGlyph /></button>
        <button type="button" aria-label="前进" disabled style={disabledNavButton}><ChevronRightGlyph /></button>
        <button type="button" aria-label="重新加载" style={navButton}><RotateCw size={14} strokeWidth={1.5} /></button>
      </div>
      <div style={{ display: 'flex', flex: 1, minWidth: 0, justifyContent: 'center' }}>
        <div style={{ position: 'relative', display: 'flex', width: '100%', maxWidth: 560, alignItems: 'center' }}>
          <span style={{ position: 'absolute', left: 9.375, display: 'inline-flex', pointerEvents: 'none', color: 'color-mix(in srgb, var(--foreground) 60%, transparent)' }}><Globe size={13.125} strokeWidth={1.5} /></span>
          <input
            value={url}
            placeholder="输入网址或搜索…"
            onChange={event => setUrl(event.target.value)}
            style={{ width: '100%', height: 22.5, boxSizing: 'border-box', padding: '0 11.25px 0 30px', border: 0, outline: 0, borderRadius: 6, background: 'var(--fg-2)', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', font: 'inherit', fontSize: 12.1875 }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <button type="button" aria-label="Home" style={navButton}><House size={14} strokeWidth={1.5} /></button>
      </div>
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>
      <SourceBrowserEmptyState />
    </div>
  </div>
}

// BrowserTabStrip: the TopBar badge row — up to three BrowserTabBadges. The
// badge is h-[26px] pl-2.5 pr-1.5 rounded-lg text-[11px] max-w-[160px]
// shadow-minimal bg-background with favicon/Globe, a truncated title, and a
// size-2.5 chevron at opacity-55.
function SourceBrowserTabStrip() {
  const tabs = [
    { id: 'docs', title: 'Polo AI Docs', favicon: null },
    { id: 'search', title: 'Hacker News', favicon: null },
  ]
  return <div data-route="browser/tab-strip" style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, flexDirection: 'column', background: 'var(--background)', color: 'var(--foreground)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 3.75, height: 32, flexShrink: 0, boxSizing: 'border-box', padding: '0 11.25px', borderBottom: `1px solid color-mix(in srgb, var(--foreground) 6%, transparent)` }}>
      {tabs.map((tab, index) => <BrowserTabBadge key={tab.id} tab={tab} active={index === 0} />)}
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>
      <SourceBrowserEmptyState />
    </div>
  </div>
}

function BrowserTabBadge({ tab, active }) {
  return <button type="button" aria-label={tab.title} style={{ display: 'inline-flex', height: 19.5, maxWidth: 120, alignItems: 'center', gap: 3.75, paddingLeft: 7.5, paddingRight: 4.5, flexShrink: 1, minWidth: 0, border: active ? '1px solid var(--accent)' : '1px solid transparent', borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 11, cursor: 'pointer' }}>
    <span style={{ display: 'inline-flex', flexShrink: 0, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)' }}><Globe size={11.25} strokeWidth={1.5} /></span>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.title}</span>
    <ChevronDown size={7.5} style={{ opacity: .55, flexShrink: 0 }} />
  </button>
}

function ChevronLeftGlyph() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg> }
function ChevronRightGlyph() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg> }
