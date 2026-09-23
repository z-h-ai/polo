import React from 'react'
import { Icon } from './icons.jsx'
import { navigate } from '../runtime/state.js'

const items = [
  { scene: 'chat', label: 'Sessions', icon: 'chat' },
  { scene: 'sources', label: 'Sources', icon: 'book' },
  { scene: 'skills', label: 'Skills', icon: 'spark' },
  { scene: 'automations', label: 'Automations', icon: 'bolt' },
]

export function NavigationRail({ query }) {
  return <aside className="resource-nav left-nav">
    <div className="nav-heading">Workspace</div>
    {items.map((item) => <button key={item.scene} className={'nav-item' + (query.scene === item.scene ? ' active' : '')} onClick={() => navigate({ scene: item.scene })}><Icon name={item.icon} size={15}/><span>{item.label}</span></button>)}
    <div className="nav-heading nav-heading-spaced">Manage</div>
    <button className={'nav-item' + (query.scene === 'organization' ? ' active' : '')} onClick={() => navigate({ scene: 'organization', state: 'select' })}><Icon name="users" size={15}/><span>Organization</span></button>
    <button className={'nav-item' + (query.scene === 'settings' ? ' active' : '')} onClick={() => navigate({ scene: 'settings', state: 'list' })}><Icon name="settings" size={15}/><span>Settings</span></button>
    <div className="nav-footer"><span className="status-dot running"/><span>Transport connected</span></div>
  </aside>
}
