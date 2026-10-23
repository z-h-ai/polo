import { Building2, Check, ChevronDown, Cloud, CloudOff, ExternalLink, FolderPlus, HelpCircle, Package, Plus, Settings2, Sparkles, Trash2 } from 'lucide-react'

// Static translation of WorkspaceSwitcher.tsx (topbar + sidebar variants),
// CompactWorkspaceSwitcher.tsx (drawer bottom sheet) and
// OrganizationSwitcher.tsx, mounted on the TopBar.tsx layout. All tailwind
// rem values are written at the prototype's 15px root; width minima that
// Tailwind resolves on its own 16px base follow the baseline table
// (min-w-40=160, min-w-56=224, min-w-64=256).
//
// Fixtures (deterministic, source cannot derive account data):
//   workspaces    我的 Workspace (local, active) / 开发环境 (remote ok,
//                 unread) / RRF 复盘 (remote, disconnected health check),
//                 remote URLs ws://192.168.1.100:9100 / ws://192.168.1.104:9100.
//   organization  Polo Studio (creator_space, owner) / Acme 工作室
//                 (enterprise, member); role labels Owner/Member are kept in
//                 English like zh-Hans.json's organization.role.* values.

const ws = [
  { id: 'ws-home', name: '我的 Workspace', remoteServer: null },
  { id: 'ws-dev', name: '开发环境', remoteServer: { url: 'ws://192.168.1.100:9100', token: 'token', remoteWorkspaceId: 'remote-home' } },
  { id: 'ws-rrf', name: 'RRF 复盘', remoteServer: { url: 'ws://192.168.1.104:9100', token: 'token', remoteWorkspaceId: 'remote-rrf' } },
]
const ACTIVE = 'ws-home'
const UNREAD = { 'ws-dev': true }
// Remote health checks run on dropdown open (testRemoteConnection IPC): 开发环境
// ok, RRF 复盘 error → disconnected (CloudOff, opacity-60, reconnect tooltip).
const HEALTH = { 'ws-dev': 'ok', 'ws-rrf': 'error' }

// ── shared chrome ────────────────────────────────────────────────────────────
const popover = width => ({ display: 'flex', flexDirection: 'column', gap: 3.75, width: 'fit-content', minWidth: width, padding: 7.5, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-modal-small)', color: 'var(--foreground)', whiteSpace: 'nowrap' })
const menuItem = extra => ({ position: 'relative', display: 'flex', alignItems: 'center', gap: 7.5, padding: '5.625px 15px 5.625px 7.5px', border: 0, borderRadius: 4, background: 'transparent', color: 'var(--foreground)', fontSize: 13.125, textAlign: 'left', ...extra })
const ringAvatar = (size, more = {}) => ({ width: size, height: size, flexShrink: 0, borderRadius: '50%', background: 'var(--muted)', display: 'grid', placeItems: 'center', overflow: 'hidden', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--border) 50%, transparent)', ...more })
const dot = { width: 7.5, height: 7.5, flexShrink: 0, borderRadius: '50%', background: 'var(--accent)' }
const sep = { height: 1, margin: '3.75px -7.5px', border: 0, background: 'color-mix(in srgb, var(--foreground) 10%, transparent)' }

function WorkspaceAvatar({ name, size, more = {} }) {
  return <span aria-hidden="true" style={ringAvatar(size, { fontSize: Math.round(size * 0.625), ...more })}>{name.charAt(0)}</span>
}

// WorkspaceSwitcher dropdown rows. Hover-only actions (opacity-0
// group-hover:opacity-100 touch-reveal) are shown on the 开发环境 row as a
// named "simulated hover" fixture so Trash2/ExternalLink are visible in the
// static export.
function WorkspaceMenuRow({ w, active, disconnected, revealActions }) {
  const unread = UNREAD[w.id]
  return (
    <div role="menuitem" tabIndex={-1} style={{ ...menuItem({ justifyContent: 'space-between', background: active ? 'color-mix(in srgb, var(--foreground) 10%, transparent)' : 'transparent', opacity: disconnected ? 0.6 : 1 }) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11.25, minWidth: 0 }}>
        <WorkspaceAvatar name={w.name} size={20} more={{ fontSize: 11.25 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
        {w.remoteServer && (disconnected
          ? <span title="已断开——点击重新连接" style={{ display: 'flex', flexShrink: 0 }}><CloudOff size={13.125} style={{ color: 'var(--destructive)' }} /></span>
          : <span style={{ display: 'flex', flexShrink: 0 }}><Cloud size={13.125} style={{ color: 'var(--muted-foreground)' }} /></span>)}
        {unread && <span style={dot} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3.75 }}>
        {!active && (
          <button type="button" title="移除 Workspace" aria-label="移除 Workspace" style={{ opacity: revealActions ? 1 : 0, display: 'flex', padding: 1.875, border: 0, borderRadius: 3, background: 'transparent', color: 'var(--foreground)', cursor: 'pointer' }}><Trash2 size={13.125} /></button>
        )}
        {!active && !disconnected && (
          <button type="button" title="在新窗口中打开" aria-label="在新窗口中打开" style={{ opacity: revealActions ? 1 : 0, display: 'flex', padding: 1.875, border: 0, borderRadius: 3, background: 'transparent', color: 'var(--foreground)', cursor: 'pointer' }}><ExternalLink size={13.125} /></button>
        )}
        {active && <Check size={13.125} />}
      </div>
    </div>
  )
}

function WorkspaceMenu({ minWidth, revealOn }) {
  return (
    <div role="menu" aria-label="选择 Workspace" style={popover(minWidth)}>
      {ws.map(w => <WorkspaceMenuRow key={w.id} w={w} active={w.id === ACTIVE} disconnected={HEALTH[w.id] === 'error'} revealActions={revealOn === w.id} />)}
      <hr style={sep} />
      <button role="menuitem" type="button" style={menuItem()}>
        <FolderPlus size={15} /><span>添加 Workspace…</span>
      </button>
    </div>
  )
}

// ── TopBar frame (TopBar.tsx: 48px bar, left cluster + org + workspace) ──────
function SpaceTopBar({ open }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, background: 'var(--background)', color: 'var(--foreground)', position: 'relative' }}>
      <div style={{ flex: '0 0 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 7.5, paddingLeft: 11.25, paddingRight: 11.25, borderBottom: '1px solid color-mix(in srgb, var(--foreground) 5%, transparent)' }}>
        <div style={{ display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 1.875 }}>
          <IconButton label="切换侧栏"><PanelLeftRounded /></IconButton>
          <IconButton label="Polo AI 菜单"><PoloAiSymbol /></IconButton>
          {/* OrganizationSwitcher mounts after AppMenu in TopBar.tsx. */}
          <span style={{ position: 'relative', display: 'flex', minWidth: 0, flexShrink: 0 }}>
            <OrgTrigger open={open === 'organization'} />
            {open === 'organization' && <span style={{ position: 'absolute', left: 0, top: 'calc(100% + 4px)', zIndex: 60 }}><OrgMenu /></span>}
          </span>
          <span style={{ position: 'relative', display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 1.875, marginLeft: 3.75 }}>
            <IconButton label="返回"><ChevronBack /></IconButton>
            <IconButton label="前进"><ChevronFwd /></IconButton>
            <WorkspacePill open={open === 'workspace'} />
            {/* align="center" sideOffset={6}: dropdown centered under the pill. */}
            {open === 'workspace' && <span style={{ position: 'absolute', left: '50%', top: 'calc(100% + 6px)', transform: 'translateX(-50%)', zIndex: 60 }}><WorkspaceMenu minWidth={256} revealOn="ws-dev" /></span>}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1.875 }}>
          <IconButton label="添加面板" size={26}><Plus size={15} strokeWidth={1.5} /></IconButton>
          <IconButton label="帮助和文档" size={26}><HelpCircle size={15} strokeWidth={1.5} /></IconButton>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: 'var(--fg-2)' }} />
    </div>
  )
}

function IconButton({ size = 28, label, children }) {
  return <button type="button" aria-label={label} style={{ width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 7.5, background: 'transparent', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', cursor: 'pointer' }}>{children}</button>
}

// WorkspaceSwitcher topbar trigger: h-[30px] px-3 rounded-[8px]
// border-foreground/6 text-[13px] text-foreground/50 (foreground on open),
// avatar h-4 w-4 ring-border/50, cloud/chevron h-3 w-3 opacity-60, unread dot
// bg-accent when hasUnreadInOtherWorkspaces.
function WorkspacePill({ open }) {
  const active = ws.find(w => w.id === ACTIVE)
  const disconnected = HEALTH[ACTIVE] === 'error'
  const unread = ws.some(w => w.id !== ACTIVE && UNREAD[w.id])
  return (
    <button type="button" aria-label="选择 Workspace" style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 1.875, height: 30, padding: '0 11.25px', border: '1px solid color-mix(in srgb, var(--foreground) 6%, transparent)', borderRadius: 8, background: open ? 'color-mix(in srgb, var(--foreground) 5%, transparent)' : 'transparent', color: open ? 'var(--foreground)' : 'color-mix(in srgb, var(--foreground) 50%, transparent)', fontSize: 13, textAlign: 'left', cursor: 'pointer' }}>
      <WorkspaceAvatar name={active.name} size={15} more={{ marginRight: 5.625 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', color: open ? 'var(--foreground)' : 'color-mix(in srgb, var(--foreground) 50%, transparent)', fontWeight: 400 }}>{active.name}</span>
      {active.remoteServer && (disconnected
        ? <span title="已断开——点击重新连接" style={{ display: 'flex', flexShrink: 0 }}><CloudOff size={11.25} style={{ color: 'var(--destructive)' }} /></span>
        : <span style={{ display: 'flex', flexShrink: 0 }}><Cloud size={11.25} style={{ opacity: 0.6 }} /></span>)}
      <ChevronDown size={11.25} style={{ flexShrink: 0, opacity: 0.6 }} />
      {unread && <span style={dot} />}
    </button>
  )
}

// OrganizationSwitcher: creator_space → Sparkles, enterprise → Building2; the
// trigger renders null without an active organization — org-1 Polo Studio is
// the active fixture (owner, creator_space).
const orgActive = { id: 'org-1', type: 'creator_space', name: 'Polo Studio', status: 'active', membership: { role: 'owner', status: 'active' } }
const orgList = [
  orgActive,
  { id: 'org-2', type: 'enterprise', name: 'Acme 工作室', status: 'active', membership: { role: 'member', status: 'active' } },
]

function OrgTrigger({ compact, open }) {
  const Icon = orgActive.type === 'creator_space' ? Sparkles : Building2
  if (compact) {
    // compact = TopBarButton shape with a size-4 text-accent icon.
    return <button type="button" aria-label="切换组织" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, flexShrink: 0, padding: 0, border: 0, borderRadius: 8, background: 'transparent', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', cursor: 'pointer' }}><Icon size={15} style={{ color: 'var(--accent)' }} /></button>
  }
  return <button type="button" aria-label="切换组织" style={{ position: 'relative', minWidth: 0, maxWidth: 208, display: 'flex', alignItems: 'center', gap: 5.625, padding: '0 7.5px', border: 0, borderRadius: 7.5, background: open ? 'color-mix(in srgb, var(--foreground) 5%, transparent)' : 'transparent', color: 'color-mix(in srgb, var(--foreground) 80%, transparent)', fontSize: 13.125, cursor: 'pointer' }}>
    <Icon size={13.125} style={{ flexShrink: 0, color: 'var(--accent)' }} />
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orgActive.name}</span>
    <ChevronDown size={13.125} style={{ flexShrink: 0, color: 'var(--muted-foreground)' }} />
  </button>
}

function OrgMenu() {
  const IconFor = item => (item.type === 'creator_space' ? Sparkles : Building2)
  return (
    <div role="menu" aria-label="切换组织" style={popover(224)}>
      {orgList.map(item => {
        const Icon = IconFor(item)
        const selected = item.id === orgActive.id
        return <div key={item.id} role="menuitem" tabIndex={-1} style={menuItem({ background: selected ? 'color-mix(in srgb, var(--foreground) 10%, transparent)' : 'transparent' })}>
          <Icon size={13.125} style={{ flexShrink: 0, color: 'var(--accent)' }} />
          <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
          <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{item.membership.role === 'owner' ? 'Owner' : 'Member'}</span>
          {selected && <Check size={13.125} />}
        </div>
      })}
      <hr style={sep} />
      <button role="menuitem" type="button" style={menuItem()}><Package size={13.125} /><span>作品</span></button>
      <button role="menuitem" type="button" style={menuItem()}><Settings2 size={13.125} /><span>管理组织</span></button>
      <button role="menuitem" type="button" style={menuItem()}><Building2 size={13.125} /><span>创建另一个组织</span></button>
    </div>
  )
}

// Sidebar variant (LeftSidebar bottom slot): w-full px-2 py-1.5 rounded-md,
// avatar h-4 w-4 bg-foreground text-background, FadingText ml-1 text-sm
// (right 36px fade mask), cloud h-3 w-3 text-muted-foreground, chevron
// h-3 w-3 opacity-50. The dropdown flips above the trigger (Radix side=top
// when bottom space is exhausted); align=start sideOffset 4, min-w-40.
function SpaceSidebar() {
  const active = ws.find(w => w.id === ACTIVE)
  const disconnected = HEALTH[ACTIVE] === 'error'
  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, color: 'var(--foreground)', background: 'var(--background)' }}>
      <div style={{ width: 220, flex: '0 0 220px', height: '100%', display: 'flex', flexDirection: 'column', borderRight: '1px solid color-mix(in srgb, var(--foreground) 5%, transparent)' }}>
        <div style={{ flex: 1 }} />
        <div style={{ position: 'relative', padding: '0 8px 8px' }}>
          <span style={{ position: 'absolute', left: 7.5, bottom: 'calc(100% + 4px)', zIndex: 60 }}><WorkspaceMenu minWidth={160} /></span>
          <button type="button" aria-label="选择 Workspace" style={{ display: 'flex', alignItems: 'center', gap: 3.75, width: '100%', minWidth: 0, justifyContent: 'flex-start', padding: '5.625px 7.5px', border: 0, borderRadius: 6, background: 'color-mix(in srgb, var(--foreground) 5%, transparent)', color: 'var(--foreground)', textAlign: 'left', cursor: 'pointer' }}>
            <WorkspaceAvatar name={active.name} size={15} more={{ background: 'var(--foreground)', color: 'var(--background)', fontSize: 9.375 }} />
            <span style={{ marginLeft: 3.75, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.125, WebkitMaskImage: 'linear-gradient(to right, black, black calc(100% - 36px), transparent 100%)' }}>{active.name}</span>
            {active.remoteServer && (disconnected
              ? <span style={{ display: 'flex', flexShrink: 0 }}><CloudOff size={11.25} style={{ color: 'var(--destructive)' }} /></span>
              : <span style={{ display: 'flex', flexShrink: 0 }}><Cloud size={11.25} style={{ color: 'var(--muted-foreground)' }} /></span>)}
            <ChevronDown size={11.25} style={{ flexShrink: 0, opacity: 0.5 }} />
          </button>
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, background: 'var(--fg-2)' }} />
    </div>
  )
}

// CompactWorkspaceSwitcher: h-9 pill trigger + vaul bottom drawer. Overlay
// bg-black/50 covers the whole viewport (incl. topbar); sheet bg-background
// rounded-t-lg border-t with a bg-muted handle (h-2 w-[100px]), header p-4
// centered (bottom drawer), rows px-3 py-3 rounded-[10px] gap-3 with h-7
// avatars, remote meta rows text-xs text-foreground/50, mt-0.5 add-row.
function SpaceCompact() {
  const active = ws.find(w => w.id === ACTIVE)
  const unread = ws.some(w => w.id !== ACTIVE && UNREAD[w.id])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, background: 'var(--background)', color: 'var(--foreground)', position: 'relative' }}>
      <div style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'rgba(0, 0, 0, 0.5)' }} />
      <div style={{ flex: '0 0 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 7.5, paddingLeft: 11.25, paddingRight: 11.25, borderBottom: '1px solid color-mix(in srgb, var(--foreground) 5%, transparent)' }}>
        <div style={{ display: 'flex', minWidth: 0, flex: 1, alignItems: 'center', gap: 1.875 }}>
          <IconButton label="切换侧栏"><PanelLeftRounded /></IconButton>
          <IconButton label="Polo AI 菜单"><PoloAiSymbol /></IconButton>
          <OrgTrigger compact open={false} />
          <button type="button" aria-label="选择 Workspace" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 3.75, height: 33.75, padding: '0 11.25px', marginLeft: 3.75, border: '1px solid color-mix(in srgb, var(--foreground) 6%, transparent)', borderRadius: 8, background: 'var(--background)', color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', fontSize: 13.125, textAlign: 'left', cursor: 'pointer' }}>
            <WorkspaceAvatar name={active.name} size={20} more={{ marginRight: 5.625 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', color: 'var(--foreground)' }}>{active.name}</span>
            {active.remoteServer && <span style={{ display: 'flex', flexShrink: 0 }}><Cloud size={11.25} style={{ opacity: 0.6 }} /></span>}
            <ChevronDown size={11.25} style={{ flexShrink: 0, opacity: 0.6 }} />
            {unread && <span style={dot} />}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1.875 }}>
          <IconButton label="添加面板" size={26}><Plus size={15} strokeWidth={1.5} /></IconButton>
          <IconButton label="帮助和文档" size={26}><HelpCircle size={15} strokeWidth={1.5} /></IconButton>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: 'var(--fg-2)' }} />
      {/* vaul bottom drawer, z-modal above the overlay */}
      <div role="dialog" aria-label="选择 Workspace" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 72, display: 'flex', flexDirection: 'column', maxHeight: '80vh', background: 'var(--background)', borderTop: '1px solid color-mix(in srgb, var(--foreground) 5%, transparent)', borderTopLeftRadius: 7.5, borderTopRightRadius: 7.5 }}>
        <div style={{ width: 100, height: 7.5, flexShrink: 0, margin: '15px auto 0', borderRadius: '50%', background: 'var(--muted)' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1.875, padding: 15, textAlign: 'center' }}>
          <h2 style={{ margin: 0, color: 'var(--foreground)', fontWeight: 600, fontSize: 15 }}>选择 Workspace</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3.75, padding: '0 7.5px 7.5px', maxHeight: '60vh', overflowY: 'auto' }}>
          {ws.map(w => {
            const isActive = w.id === ACTIVE
            const disconnected = HEALTH[w.id] === 'error'
            const unreadWs = UNREAD[w.id]
            return (
              <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 11.25, padding: 11.25, borderRadius: 10, background: isActive ? 'color-mix(in srgb, var(--foreground) 5%, transparent)' : 'transparent', opacity: disconnected ? 0.6 : 1 }}>
                <button type="button" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 11.25, padding: 0, border: 0, background: 'transparent', color: 'var(--foreground)', textAlign: 'left', cursor: 'pointer' }}>
                  <WorkspaceAvatar name={w.name} size={26.25} more={{ fontSize: 13.125 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7.5, minWidth: 0 }}>
                      <span style={{ fontSize: 13.125, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                      {unreadWs && <span style={dot} />}
                    </span>
                    {w.remoteServer && <span style={{ display: 'flex', alignItems: 'center', gap: 3.75, marginTop: 1.875, fontSize: 11.25, color: 'color-mix(in srgb, var(--foreground) 50%, transparent)' }}>
                      {disconnected
                        ? <><CloudOff size={11.25} style={{ flexShrink: 0, color: 'var(--destructive)' }} /><span>已断开——点击重新连接</span></>
                        : <><Cloud size={11.25} style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.remoteServer.url}</span></>}
                    </span>}
                  </span>
                </button>
                {!isActive && (
                  <button type="button" aria-label="移除 Workspace" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 33.75, height: 33.75, padding: 0, border: 0, borderRadius: 8, background: 'transparent', color: 'color-mix(in srgb, var(--foreground) 50%, transparent)', cursor: 'pointer' }}><Trash2 size={15} /></button>
                )}
                {!isActive && !disconnected && (
                  <button type="button" aria-label="在新窗口中打开" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 33.75, height: 33.75, padding: 0, border: 0, borderRadius: 8, background: 'transparent', color: 'color-mix(in srgb, var(--foreground) 50%, transparent)', cursor: 'pointer' }}><ExternalLink size={15} /></button>
                )}
                {isActive && <Check size={15} style={{ flexShrink: 0, color: 'color-mix(in srgb, var(--foreground) 60%, transparent)', marginRight: 7.5 }} />}
              </div>
            )
          })}
          <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 11.25, marginTop: 3.75, padding: 11.25, border: 0, borderRadius: 10, background: 'transparent', color: 'var(--foreground)', textAlign: 'left', cursor: 'pointer' }}>
            <span style={{ display: 'flex', width: 26.25, height: 26.25, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'color-mix(in srgb, var(--foreground) 5%, transparent)' }}>
              <FolderPlus size={15} style={{ color: 'color-mix(in srgb, var(--foreground) 60%, transparent)' }} />
            </span>
            <span style={{ fontSize: 13.125, fontWeight: 500 }}>添加 Workspace…</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export function SourceSpaceSwitcher({ state }) {
  if (state === 'topbar-open') return <div data-route="space-switcher/topbar-open" style={{ width: '100%', height: '100%', minHeight: 0 }}><SpaceTopBar open="workspace" /></div>
  if (state === 'sidebar-open') return <div data-route="space-switcher/sidebar-open" style={{ width: '100%', height: '100%', minHeight: 0 }}><SpaceSidebar /></div>
  if (state === 'compact') return <div data-route="space-switcher/compact" style={{ width: '100%', height: '100%', minHeight: 0 }}><SpaceCompact /></div>
  if (state === 'organization') return <div data-route="space-switcher/organization" style={{ width: '100%', height: '100%', minHeight: 0 }}><SpaceTopBar open="organization" /></div>
  return <div data-route="space-switcher/topbar" style={{ width: '100%', height: '100%', minHeight: 0 }}><SpaceTopBar /></div>
}

// ── icons (TopBar.tsx imports) ───────────────────────────────────────────────
function PanelLeftRounded() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4V20M3.5 11.5L3.5 12.5C3.5 16.2712 3.5 18.1569 4.67157 19.3284C5.84315 20.5 7.72876 20.5 11.5 20.5L12.5 20.5C16.2712 20.5 18.1569 20.5 19.3284 19.3284C20.5 18.1569 20.5 16.2712 20.5 12.5L20.5 11.5C20.5 7.72876 20.5 5.84315 19.3284 4.67157C18.1569 3.5 16.2712 3.5 12.5 3.5L11.5 3.5C7.72876 3.5 5.84315 3.5 4.67157 4.67157C3.5 5.84315 3.5 7.72876 3.5 11.5Z" /></svg> }
function PoloAiSymbol() { return <svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><path d="M 22 85 V 10 H 44 A 19 19 0 0 1 44 48 H 34" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" /><circle cx="42" cy="76" r="9" fill="currentColor" /><path d="M 60 65 V 85 H 68" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /><circle cx="84" cy="76" r="9" fill="currentColor" /></svg> }
function ChevronBack() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg> }
function ChevronFwd() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg> }