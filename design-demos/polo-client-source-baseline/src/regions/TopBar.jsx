import React, { useState } from 'react'
import { Icon, Logo } from './icons.jsx'
import { navigate } from '../runtime/state.js'
import { Menu } from '../runtime/interaction-primitives.jsx'

const tabs = [
  { id: 'home', label: 'Home', icon: 'grid' },
  { id: 'chat', label: 'Polo', icon: 'spark' },
  { id: 'browser', label: 'Browser', icon: 'external' },
]

export function TopBar({ query, onToast }) {
  const [spaceOpen, setSpaceOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const selectScene = (scene, state = 'normal') => {
    navigate({ scene, state })
    setSpaceOpen(false)
    setMenuOpen(false)
  }
  return <header className="workbench-bar">
    <button className="brand-lockup" onClick={() => selectScene('home')} aria-label="Open Home"><Logo compact /><span>Polo AI</span></button>
    <div className="space-control">
      <button className="space-trigger" aria-expanded={spaceOpen} onClick={() => setSpaceOpen((value) => !value)}>
        <span className="space-avatar">P</span><span className="space-copy"><strong>Polo workspace</strong><small>Creator Space · connected</small></span><Icon name="chevron" size={14}/>
      </button>
      {spaceOpen && <Menu className="popover" onClose={() => setSpaceOpen(false)}>
        <div className="menu-section-title">Workspaces</div>
        <button className="space-row active" onClick={() => selectScene('home')}><span className="space-avatar">P</span><span><b>Polo workspace</b><small>Creator Space</small></span><Icon name="check" size={14}/></button>
        <button className="space-row" onClick={() => selectScene('workspace-picker', 'list')}><span className="space-avatar">+</span><span><b>Add workspace</b><small>Open or connect a folder</small></span><Icon name="plus" size={14}/></button>
        <div className="menu-divider"/>
        <button className="menu-row" onClick={() => selectScene('organization', 'select')}><Icon name="users" size={16}/><span><b>Manage organization</b><small>Members and artifacts</small></span></button>
      </Menu>}
    </div>
    <nav className="tabs" aria-label="Primary tabs">
      {tabs.map((tab) => <button key={tab.id} className={'tab' + (query.scene === tab.id ? ' active' : '')} onClick={() => selectScene(tab.id)}><Icon name={tab.icon} size={15}/><span>{tab.label}</span>{tab.id !== 'home' && <span className="tab-close" aria-hidden="true">×</span>}</button>)}
    </nav>
    <div className="bar-actions">
      <button className="bar-button" onClick={() => selectScene('sources')}><Icon name="book" size={14}/><span>Resources</span></button>
      <button className="bar-button" onClick={() => selectScene('settings')}><Icon name="settings" size={14}/><span>Settings</span></button>
      <button className="icon-button" onClick={() => onToast('No new notifications')} aria-label="Notifications"><Icon name="info" size={16}/></button>
      <div className="menu-anchor">
        <button className="avatar-button" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>W</button>
        {menuOpen && <Menu className="menu-panel account-menu" onClose={() => setMenuOpen(false)}>
          <div className="menu-label">Signed in as</div>
          <div className="menu-row"><span className="space-avatar">W</span><span><b>Workspace admin</b><small>admin@polo.local</small></span></div>
          <div className="menu-divider"/>
          <button className="menu-row" onClick={() => selectScene('settings', 'appearance')}><Icon name="moon" size={16}/><span><b>Appearance</b><small>Light theme</small></span></button>
          <button className="menu-row" onClick={() => selectScene('shortcuts')}><Icon name="command" size={16}/><span><b>Keyboard shortcuts</b><small>View all commands</small></span></button>
          <button className="menu-row" onClick={() => selectScene('reauth', 'normal')}><Icon name="lock" size={16}/><span><b>Lock and re-authenticate</b><small>Protect this workspace</small></span></button>
        </Menu>}
      </div>
    </div>
  </header>
}
