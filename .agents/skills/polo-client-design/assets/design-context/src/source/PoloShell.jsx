import { Archive, Bot, ChevronDown, ChevronLeft, ChevronRight, Clock, DatabaseZap, Flag, FolderOpen, Globe, HelpCircle, House, Inbox, ListFilter, ListTodo, Plus, Radio, Tag, X, Zap } from 'lucide-react'
import { useState } from 'react'

// Source composition: TabBar.tsx + TopBar.tsx + AppShell.tsx +
// PanelStackContainer.tsx + LeftSidebar.tsx. This export selects their desktop
// defaults: 36px tab bar, 48px top bar, 220px sidebar, 300px navigator, 6px
// panel gap, and a 440px content minimum. Labels use zh-Hans, the prototype's
// default locale. TabBar's left padding is 86px on macOS, 8px elsewhere.
export function SourcePoloShell({ iconSrc, navigator, children }) {
  const [sidebarVisible, setSidebarVisible] = useState(true)
  return <div className="source-shell">
    <div className="source-tabbar">
      <button type="button" className="source-tabbar__home" aria-label="Home"><House size={15} strokeWidth={1.5}/></button>
      <div className="source-tabbar__tabs"><button type="button" className="source-tabbar__tab source-tabbar__tab--active"><img src={iconSrc} alt=""/><span>Polo 助手</span><span className="source-tabbar__close" aria-label="Close Polo 助手"><X size={13.125} strokeWidth={1.5}/></span></button></div>
    </div>
    <div className="source-topbar">
      <div className="source-topbar__left">
        <button type="button" className="source-icon-button" aria-label="切换侧栏" onClick={() => setSidebarVisible(value => !value)}><PanelLeftRounded/></button>
        <button type="button" className="source-icon-button" aria-label="Polo AI 菜单"><PoloAiSymbol/></button>
        {/* OrganizationSwitcher renders null without an active organization
            (fresh-profile fixture), so no switcher is mounted here. */}
        <div className="source-topbar__workspace">
          <button type="button" className="source-icon-button" disabled aria-label="返回"><ChevronLeft size={18} strokeWidth={1.5}/></button>
          <button type="button" className="source-icon-button" disabled aria-label="前进"><ChevronRight size={18} strokeWidth={1.5}/></button>
          <button type="button" className="source-workspace-switcher" aria-label="选择 Workspace"><span className="source-workspace-switcher__avatar"/><span>Workspace</span><ChevronDown size={12}/></button>
        </div>
      </div>
      <div className="source-topbar__right"><button type="button" className="source-icon-button" aria-label="添加面板"><Plus size={16} strokeWidth={1.5}/></button><button type="button" className="source-icon-button" aria-label="帮助和文档"><HelpCircle size={16} strokeWidth={1.5}/></button></div>
    </div>
    <main className={'source-panel-stack' + (sidebarVisible ? '' : ' source-panel-stack--without-sidebar') + (navigator === false ? ' source-panel-stack--direct' : '')}>
      {sidebarVisible && <aside className="source-sidebar" aria-label="主导航"><button className="source-new-session" type="button"><SquarePenRounded/>新建会话</button><nav className="source-sidebar__nav"><Nav icon={Inbox} label="所有会话" active/><div className="source-sidebar__nested"><Nav label="已标记" icon={Flag}/><Nav label="已归档" icon={Archive}/></div><Nav icon={Tag} label="标签"/><hr/><Nav icon={DatabaseZap} label="数据源"/><div className="source-sidebar__nested"><Nav icon={Globe} label="API"/><Nav icon={McpGlyph} label="MCP"/><Nav icon={FolderOpen} label="本地文件夹"/></div><Nav icon={Zap} label="技能"/><Nav icon={ListTodo} label="自动化"/><div className="source-sidebar__nested"><Nav icon={Clock} label="定时任务"/><Nav icon={Radio} label="事件触发"/><Nav icon={Bot} label="智能体"/></div></nav><div className="source-sidebar__footer"><button type="button" className="source-sidebar__user"><span className="source-sidebar__user-avatar">P</span><span className="source-sidebar__user-name">Polo User</span><ChevronDown/></button></div></aside>}
      {navigator === false ? children : <><section className="source-navigator" aria-label="会话">{navigator ?? <NavigatorSessions/>}</section><section className="source-content-panel">{children}</section></>}
    </main>
  </div>
}

function NavigatorSessions() {
  return <>
    <div className="source-navigator__header"><span className="source-navigator__header-title">所有会话</span><button type="button" className="source-navigator__header-button" aria-label="筛选聊天"><ListFilter/></button></div>
    <div className="source-navigator__list"><div className="source-navigator__empty"><Inbox strokeWidth={1.5}/><strong>暂无会话</strong><p>与智能体的会话将显示在这里。开始一个吧。</p><button type="button">新建会话</button></div></div>
  </>
}

function Nav({ icon: Icon, label, active = false }) { return <button type="button" className={'source-nav-item' + (active ? ' is-active' : '')}><Icon size={14} strokeWidth={1.5}/><span>{label}</span></button> }
function PoloAiSymbol(){return <svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><path d="M 22 85 V 10 H 44 A 19 19 0 0 1 44 48 H 34" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="42" cy="76" r="9" fill="currentColor"/><path d="M 60 65 V 85 H 68" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="84" cy="76" r="9" fill="currentColor"/></svg>}
function PanelLeftRounded(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4V20M3.5 11.5L3.5 12.5C3.5 16.2712 3.5 18.1569 4.67157 19.3284C5.84315 20.5 7.72876 20.5 11.5 20.5L12.5 20.5C16.2712 20.5 18.1569 20.5 19.3284 19.3284C20.5 18.1569 20.5 16.2712 20.5 12.5L20.5 11.5C20.5 7.72876 20.5 5.84315 19.3284 4.67157C18.1569 3.5 16.2712 3.5 12.5 3.5L11.5 3.5C7.72876 3.5 5.84315 3.5 4.67157 4.67157C3.5 5.84315 3.5 7.72876 3.5 11.5Z"/></svg>}
function SquarePenRounded(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-5"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>}
function McpGlyph(props){return <svg viewBox="18 22 150 170" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round" aria-hidden="true" {...props}><path d="M25 97.8528L92.8823 29.9706C102.255 20.598 117.451 20.598 126.823 29.9706V29.9706C136.196 39.3431 136.196 54.5391 126.823 63.9117L75.5581 115.177"/><path d="M76.2653 114.47L126.823 63.9117C136.196 54.5391 151.392 54.5391 160.765 63.9117L161.118 64.2652C170.491 73.6378 170.491 88.8338 161.118 98.2063L99.7248 159.6C96.6006 162.724 96.6006 167.789 99.7248 170.913L112.331 183.52"/><path d="M109.853 46.9411L59.6482 97.1457C50.2757 106.518 50.2757 121.714 59.6482 131.087V131.087C69.0208 140.459 84.2168 140.459 93.5894 131.087L143.794 80.8822"/></svg>}
