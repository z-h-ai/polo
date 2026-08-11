import { House, X } from 'lucide-react'

// Source: TabShell.tsx, TabBar.tsx and TabContent.tsx. Home is a TabContent
// branch, so it deliberately has a tab bar but not the AppShell TopBar/sidebar.
export function SourceHomeTabFrame({ iconSrc, children }) {
  return <div className="source-home-frame">
    <div className="source-tabbar">
      <button type="button" className="source-tabbar__home" aria-label="Home"><House size={16} strokeWidth={1.5}/></button>
      <div className="source-tabbar__tabs">
        <button type="button" className="source-tabbar__tab source-tabbar__tab--active">
          <img src={iconSrc} alt=""/><span>Polo 助手</span><span className="source-tabbar__close" aria-label="Close Polo 助手"><X size={14} strokeWidth={1.5}/></span>
        </button>
      </div>
    </div>
    <div className="source-home-frame__content">{children}</div>
  </div>
}
