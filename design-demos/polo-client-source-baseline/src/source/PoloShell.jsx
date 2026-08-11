import { Archive, Bot, ChevronDown, ChevronLeft, ChevronRight, Clock, DatabaseZap, FolderOpen, Globe, HelpCircle, House, Inbox, ListTodo, Plus, Radio, Tag, X, Zap } from 'lucide-react'
import { useState } from 'react'

// Source composition: TabBar.tsx + TopBar.tsx + AppShell.tsx +
// PanelStackContainer.tsx + LeftSidebar.tsx. This export selects their desktop
// defaults: 36px tab bar, 48px top bar, 220px sidebar, 300px navigator, 6px
// panel gap, and a 440px content minimum.
export function SourcePoloShell({ iconSrc, navigator, children }) {
  const [sidebarVisible, setSidebarVisible] = useState(true)
  return <div className="source-shell">
    <div className="source-tabbar">
      <button type="button" className="source-tabbar__home" aria-label="Home"><House size={16} strokeWidth={1.5}/></button>
      <div className="source-tabbar__tabs"><button type="button" className="source-tabbar__tab source-tabbar__tab--active"><img src={iconSrc} alt=""/><span>Polo 助手</span><span className="source-tabbar__close" aria-label="Close Polo 助手"><X size={14} strokeWidth={1.5}/></span></button></div>
    </div>
    <div className="source-topbar">
      <div className="source-topbar__left">
        <button type="button" className="source-icon-button" aria-label="Toggle Sidebar" onClick={() => setSidebarVisible(value => !value)}><PanelLeftRounded/></button>
        <button type="button" className="source-icon-button" aria-label="Polo AI menu"><PoloAiSymbol/></button>
        <div className="source-topbar__workspace">
          <button type="button" className="source-icon-button" disabled aria-label="Back"><ChevronLeft size={18} strokeWidth={1.5}/></button>
          <button type="button" className="source-icon-button" disabled aria-label="Forward"><ChevronRight size={18} strokeWidth={1.5}/></button>
          <button type="button" className="source-workspace-switcher"><span className="source-workspace-switcher__avatar"/><span>Workspace</span><ChevronDown size={12}/></button>
        </div>
      </div>
      <div className="source-topbar__right"><button type="button" className="source-icon-button" aria-label="Add panel menu"><Plus size={16} strokeWidth={1.5}/></button><button type="button" className="source-icon-button" aria-label="Help & Documentation"><HelpCircle size={16} strokeWidth={1.5}/></button></div>
    </div>
    <main className={'source-panel-stack' + (sidebarVisible ? '' : ' source-panel-stack--without-sidebar') + (navigator === false ? ' source-panel-stack--direct' : '')}>
      {sidebarVisible && <aside className="source-sidebar" aria-label="Main navigation"><button className="source-new-session" type="button"><SquarePenRounded/>New Session</button><nav className="source-sidebar__nav"><Nav icon={Inbox} label="All Sessions" active/><div className="source-sidebar__nested"><Nav label="Flagged" icon={FlagGlyph}/><Nav label="Archived" icon={Archive}/></div><Nav icon={Tag} label="Labels"/><hr/><Nav icon={DatabaseZap} label="Sources"/><div className="source-sidebar__nested"><Nav icon={Globe} label="APIs"/><Nav icon={McpGlyph} label="MCP"/><Nav icon={FolderOpen} label="Local Folders"/></div><Nav icon={Zap} label="Skills"/><Nav icon={ListTodo} label="Automations"/><div className="source-sidebar__nested"><Nav icon={Clock} label="Scheduled"/><Nav icon={Radio} label="Event"/><Nav icon={Bot} label="Agentic"/></div></nav></aside>}
      {navigator === false ? children : <><section className="source-navigator" aria-label="Sessions">{navigator ?? <div className="source-navigator__empty"><Inbox size={20} strokeWidth={1.5}/><strong>No sessions yet</strong><p>Sessions with your agent appear here. Start one to get going.</p><button type="button">New Session</button></div>}</section><section className="source-content-panel">{children}</section></>}
    </main>
  </div>
}

function Nav({ icon: Icon, label, active = false }) { return <button type="button" className={'source-nav-item' + (active ? ' is-active' : '')}><Icon size={14} strokeWidth={1.5}/><span>{label}</span></button> }
function PoloAiSymbol(){return <svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><path d="M 22 85 V 10 H 44 A 19 19 0 0 1 44 48 H 34" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="42" cy="76" r="9" fill="currentColor"/><path d="M 60 65 V 85 H 68" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="84" cy="76" r="9" fill="currentColor"/></svg>}
function PanelLeftRounded(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4V20M3.5 11.5L3.5 12.5C3.5 16.2712 3.5 18.1569 4.67157 19.3284C5.84315 20.5 7.72876 20.5 11.5 20.5L12.5 20.5C16.2712 20.5 18.1569 20.5 19.3284 19.3284C20.5 18.1569 20.5 16.2712 20.5 12.5L20.5 11.5C20.5 7.72876 20.5 5.84315 19.3284 4.67157C18.1569 3.5 16.2712 3.5 12.5 3.5L11.5 3.5C7.72876 3.5 5.84315 3.5 4.67157 4.67157C3.5 5.84315 3.5 7.72876 3.5 11.5Z"/></svg>}
function SquarePenRounded(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-5"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>}
function McpGlyph(props){return <svg viewBox="18 22 150 170" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round" aria-hidden="true" {...props}><path d="M25 97.8528L92.8823 29.9706C102.255 20.598 117.451 20.598 126.823 29.9706V29.9706C136.196 39.3431 136.196 54.5391 126.823 63.9117L75.5581 115.177"/><path d="M76.2653 114.47L126.823 63.9117C136.196 54.5391 151.392 54.5391 160.765 63.9117L161.118 64.2652C170.491 73.6378 170.491 88.8338 161.118 98.2063L99.7248 159.6C96.6006 162.724 96.6006 167.789 99.7248 170.913L112.331 183.52"/><path d="M109.853 46.9411L59.6482 97.1457C50.2757 106.518 50.2757 121.714 59.6482 131.087V131.087C69.0208 140.459 84.2168 140.459 93.5894 131.087L143.794 80.8822"/></svg>}
function FlagGlyph(props){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/></svg>}
