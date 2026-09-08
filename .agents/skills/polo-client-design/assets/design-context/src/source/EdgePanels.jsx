import { Archive, ArrowUpRight, CheckCircle2, ChevronDown, Cloud, CloudOff, Flag, Send, Square, Tag, Trash2, X, Plus } from 'lucide-react'

// Edge panels & overlays — static translations of TaskActionMenu.tsx
// (ActiveTasksBar), MultiSelectPanel.tsx, BatchSessionMenu.tsx,
// SendToWorkspaceDialog.tsx and FabNewChat.tsx. Tasks, selection counts,
// remote workspaces and health results are named deterministic fixtures;
// IPC actions, toast feedback and progress events stay un-wired. Copy is
// zh-Hans where the locale file defines it; the transfer button keeps the
// source's hardcoded English "Cancel"/"Send"/"Sending...". Root font-size
// 15px.

const muted = 'var(--fg-50)'
const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'
const ghostButton = { display: 'inline-flex', height: 30, alignItems: 'center', gap: 7.5, padding: '0 11.25px', border: 0, borderRadius: 6, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500 }
const defaultButton = { display: 'inline-flex', height: 33.75, alignItems: 'center', gap: 7.5, padding: '0 15px', border: 0, borderRadius: 8, background: 'var(--foreground)', color: 'var(--background)', fontSize: 13.125, fontWeight: 500 }
const outlineButton = { ...defaultButton, background: 'var(--background)', color: 'var(--foreground)', border: `1px solid ${fg15}` }

// ---------------------------------------------------------------------------
// TaskActionMenu — the ActiveTasksBar badge row + its open dropdown.
// One agent task (event-driven elapsed) and one shell task (locally timed).
// ---------------------------------------------------------------------------

const taskFixture = [
  { id: 'tsk_9f3a2c1e', type: 'agent', intent: '整理 changelog 条目结构', elapsedSeconds: 134 },
  { id: 'sh-8b1d4f', type: 'shell', intent: 'git push origin main', elapsedSeconds: 45 },
]

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function shortenId(id) {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id
}

function Spin() {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 11.25, height: 11.25, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
}

function TaskBadge({ task }) {
  return <button type="button" title="点击查看任务操作" style={{ display: 'flex', height: 30, alignItems: 'center', gap: 5.625, padding: '0 7.5px 0 9.375px', borderRadius: 8, border: 0, background: '#fff', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}>
    <Spin />
    <span style={{ opacity: 0.6 }}>{task.type === 'agent' ? '任务' : 'Shell'}</span>
    <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.8 }}>{shortenId(task.id)}</span>
    <span style={{ opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>{formatElapsed(task.elapsedSeconds)}</span>
    <ChevronDown size={13.125} style={{ opacity: 0.6, marginLeft: 'auto' }} />
  </button>
}

export function SourceActiveTasksBar() {
  return <div data-route="chat/active-tasks" style={{ position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 30, background: 'var(--fg-2)', color: 'var(--foreground)', overflow: 'hidden' }}>
    {/* Chat input area background — the task badges float above the composer */}
    <div style={{ position: 'absolute', left: '50%', bottom: 86, transform: 'translateX(-50%)', width: 'min(720px, 100%)', display: 'flex', gap: 7.5, padding: '0 20px' }}>
      {taskFixture.map(task => <TaskBadge key={task.id} task={task} />)}
    </div>
    {/* Open dropdown on the agent badge (static): view output / separator / stop */}
    <div style={{ position: 'absolute', left: '50%', bottom: 128, transform: 'translateX(calc(-50% + 1px))', display: 'flex', flexDirection: 'column', gap: 3.75, padding: 3.75, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-modal-small)', color: 'var(--foreground)', minWidth: 170, zIndex: 5 }}>
      <MenuItem icon={<ArrowUpRight size={13.125} />} label="查看输出" />
      <div aria-hidden="true" style={{ height: 1, margin: 0, background: fg15 }} />
      <MenuItem icon={<Square size={13.125} />} label="停止任务" />
    </div>
  </div>
}

function MenuItem({ icon, label, destructive, disabled }) {
  return <button type="button" disabled={disabled} style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '5.625px 7.5px 5.625px 9.375px', border: 0, borderRadius: 6, background: 'transparent', color: destructive ? 'var(--destructive)' : 'var(--foreground)', fontSize: 13.125, textAlign: 'left', cursor: 'pointer', opacity: disabled ? 0.3 : 1 }}><span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span><span style={{ flex: 1 }}>{label}</span></button>
}

// ---------------------------------------------------------------------------
// MultiSelectPanel — full-height centered selection state with batch actions.
// ---------------------------------------------------------------------------

function Kbd({ children, style }) {
  return <kbd style={{ display: 'inline-flex', alignItems: 'center', padding: '1.875px 5.625px', borderRadius: 4, background: 'var(--fg-5)', color: 'color-mix(in srgb, var(--foreground) 80%, transparent)', fontSize: 10, fontWeight: 500, lineHeight: 1.4, ...style }}>{children}</kbd>
}

function KbdGroup({ children }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3.75 }}>{children}</span>
}

export function SourceMultiSelectPanel() {
  return <div data-route="multi-select/panel" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22.5, boxSizing: 'border-box', padding: 30, background: 'var(--fg-2)', color: 'var(--foreground)' }}>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7.5 }}>
      <div style={{ display: 'flex', width: 60, height: 60, alignItems: 'center', justifyContent: 'center', borderRadius: 9999, background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}>
        <span style={{ fontSize: 22.5, fontWeight: 600, color: 'var(--accent)' }}>3</span>
      </div>
      <h2 style={{ margin: 0, fontSize: 18.75, fontWeight: 500, lineHeight: 1.35 }}>已选择 3 个会话</h2>
      <div style={{ fontSize: 13.125, color: 'color-mix(in srgb, var(--foreground) 50%, transparent)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3.75, lineHeight: 1.4286 }}>
        <span>使用 <KbdGroup><Kbd>⌘</Kbd><Kbd>点击</Kbd></KbdGroup> 切换，使用 <KbdGroup><Kbd>⇧</Kbd><Kbd>点击</Kbd></KbdGroup> 进行范围选择</span>
        <span>按 <Kbd>Esc</Kbd> 清除选择</span>
      </div>
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 7.5 }}>
      <button type="button" style={ghostButton}><CheckCircle2 size={15} />更改状态</button>
      <button type="button" style={ghostButton}><Tag size={15} />设置标签</button>
      <button type="button" style={ghostButton}><Send size={15} />发送到 Workspace...</button>
      <button type="button" style={ghostButton}><Archive size={15} />归档</button>
    </div>
  </div>
}

// ---------------------------------------------------------------------------
// BatchSessionMenu — context-menu content for multi-selected sessions, with
// the Status submenu expanded (StaticDropdown chrome).
// ---------------------------------------------------------------------------

function SubMenuItem({ icon, label, color, expanded }) {
  return <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '5.625px 7.5px 5.625px 9.375px', borderRadius: 6, border: 0, background: expanded ? 'color-mix(in srgb, var(--foreground) 5%, transparent)' : 'transparent', color: 'var(--foreground)', fontSize: 13.125, textAlign: 'left', cursor: 'pointer' }}>
    {icon ? <span style={{ display: 'inline-flex', flexShrink: 0, color }}>{icon}</span> : <span style={{ width: 13.125, height: 13.125, flexShrink: 0 }} />}
    <span style={{ flex: 1 }}>{label}</span>
    <ChevronDown size={13.125} style={{ opacity: 0.5, transform: 'rotate(-90deg)' }} />
  </button>
}

function BatchStatusRow({ label, checked, colour }) {
  return <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '5.625px 7.5px 5.625px 9.375px', borderRadius: 6, border: 0, background: 'transparent', color: 'var(--foreground)', fontSize: 13.125, textAlign: 'left', cursor: 'pointer' }}>
    <span style={{ display: 'inline-flex', flexShrink: 0, color: colour || 'var(--foreground)' }}><CheckCircle2 size={13.125} /></span>
    <span style={{ flex: 1 }}>{label}</span>
    {checked && <span style={{ width: 15, height: 15, borderRadius: 9999, border: '3px solid var(--foreground)', boxSizing: 'border-box' }} />}
  </button>
}

export function SourceBatchSessionMenu() {
  return <div data-route="multi-select/menu" style={{ position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box', padding: 30, background: 'var(--fg-2)', color: 'var(--foreground)', overflow: 'hidden' }}>
    {/* Main menu */}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3.75, padding: 3.75, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-modal-small)', minWidth: 224, position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
      <div style={{ padding: '5.625px 7.5px 5.625px 9.375px', fontSize: 11.25, color: 'var(--fg-50)', fontWeight: 500 }}>已选择 3 个会话</div>
      <div aria-hidden="true" style={{ height: 1, margin: 0, background: fg15 }} />
      <SubMenuItem icon={null} label="状态" expanded />
      <SubMenuItem icon={<Tag size={13.125} />} label="标签" />
      <MenuItem icon={<Flag size={13.125} style={{ color: 'var(--info)' }} />} label="全部标记" />
      <MenuItem icon={<Archive size={13.125} />} label="归档" />
      <MenuItem icon={<Send size={13.125} />} label="发送到 Workspace..." />
      <div aria-hidden="true" style={{ height: 1, margin: 0, background: fg15 }} />
      <MenuItem icon={<Trash2 size={13.125} />} label="删除" destructive />
      {/* Expanded status submenu (float right) */}
      <div style={{ position: 'absolute', left: 'calc(100% + 4px)', top: 52, display: 'flex', flexDirection: 'column', gap: 3.75, padding: 3.75, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-modal-small)', minWidth: 168 }}>
        <BatchStatusRow label="待办" checked colour="var(--info)" />
        <BatchStatusRow label="进行中" />
        <BatchStatusRow label="已完成" />
        <BatchStatusRow label="已归档" />
      </div>
    </div>
  </div>
}

// ---------------------------------------------------------------------------
// SendToWorkspaceDialog — remote-only workspace picker. Health fixtures:
// dev-server ok (selected), staging ok, edge-lab disconnected (CloudOff,
// disabled). The transferring state shows the purple LED progress border.
// ---------------------------------------------------------------------------

function RemoteRow({ name, health, selected }) {
  const connected = health !== 'error'
  return <button type="button" disabled={health === 'error'} style={{ display: 'flex', alignItems: 'center', gap: 7.5, width: '100%', padding: '7.5px', borderRadius: 6, textAlign: 'left', fontSize: 13.125, color: 'var(--foreground)', border: 0, background: selected ? 'color-mix(in srgb, var(--foreground) 10%, transparent)' : 'transparent', boxShadow: selected ? '0 0 0 1px color-mix(in srgb, var(--foreground) 15%, transparent)' : 'none', cursor: health === 'error' ? 'not-allowed' : 'pointer', opacity: health === 'error' ? 0.5 : 1 }}>
    <span style={{ display: 'inline-flex', width: 18.75, height: 18.75, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 9999, background: 'var(--fg-5)', color: 'var(--fg-50)', fontSize: 10, boxShadow: '0 0 0 1px color-mix(in srgb, var(--border) 50%, transparent)' }}>{name.charAt(0)}</span>
    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    {health === 'error' ? <CloudOff size={13.125} style={{ color: 'color-mix(in srgb, var(--foreground) 50%, transparent)', flexShrink: 0 }} /> : <Cloud size={13.125} style={{ color: muted, flexShrink: 0 }} />}
  </button>
}

function SendDialogShell({ route, title, description, children, footer, progress }) {
  return <div data-route={`send-remote/${route}`} style={{ position: 'relative', display: 'grid', width: '100%', height: '100%', minHeight: 0, placeItems: 'center', background: 'rgba(0,0,0,.5)' }}>
    <section role="dialog" aria-modal="true" style={{ position: 'relative', display: 'grid', width: 'min(384px, calc(100% - 32px))', gap: 15, boxSizing: 'border-box', padding: 22.5, borderRadius: 8, background: 'var(--background)', color: 'var(--foreground)', boxShadow: 'var(--shadow-modal-small)' }}>
      <button type="button" aria-label="Close" style={{ position: 'absolute', top: 15, right: 15, display: 'flex', padding: 0, border: 0, borderRadius: 2, background: 'none', color: 'inherit', opacity: 0.7, cursor: 'pointer' }}><X size={16} /></button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7.5 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 7.5, fontSize: 18.75, lineHeight: 1, fontWeight: 600 }}><Send size={15} />{title}</h2>
        {description && <p style={{ margin: 0, color: muted, fontSize: 13.125 }}>{description}</p>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3.75, maxHeight: 240, overflowY: 'auto', padding: '3.75px 0' }}>{children}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7.5 }}>{footer}</div>
    </section>
  </div>
}

export function SourceSendToWorkspace({ state = 'list' }) {
  const transferring = state === 'transferring'
  const footer = <>
    <button type="button" style={{ ...outlineButton, opacity: transferring ? 0.5 : 1, cursor: transferring ? 'not-allowed' : 'pointer' }}>Cancel</button>
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" style={{ ...defaultButton, cursor: transferring ? 'wait' : 'pointer' }}>{transferring ? 'Sending...' : 'Send'}</button>
      {transferring && <svg style={{ position: 'absolute', inset: -3, width: 'calc(100% + 6px)', height: 'calc(100% + 6px)', overflow: 'visible', pointerEvents: 'none' }}><rect x="1.5" y="1.5" width="calc(100% - 3px)" height="calc(100% - 3px)" rx="10" ry="10" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeDasharray="45 999" style={{ transition: 'stroke-dasharray 0.2s ease-out', filter: 'drop-shadow(0 0 3px #8B5CF6) drop-shadow(0 0 6px rgba(139,92,246,0.3))' }} /></svg>}
    </span>
  </>
  return <SendDialogShell route={state} title="发送到 Workspace" description={transferring ? '正在将 3 个会话发送到远程 Workspace。' : '将 3 个会话发送到远程 Workspace。'} footer={footer}>
    {state === 'offline' ? <>
      <RemoteRow name="dev-server" health="error" selected={false} />
      <RemoteRow name="staging" health="error" selected={false} />
      <RemoteRow name="edge-lab" health="error" selected={false} />
    </> : <>
      <RemoteRow name="dev-server" health="ok" selected={!transferring} />
      <RemoteRow name="staging" health="ok" selected={false} />
      <RemoteRow name="edge-lab" health="error" selected={false} />
    </>}
  </SendDialogShell>
}

// ---------------------------------------------------------------------------
// FabNewChat — bottom-right floating action button on compact layouts
// (portal to document.body in the real app; here a standalone fixture).
// ---------------------------------------------------------------------------

export function SourceFabNewChat() {
  return <div data-route="chat/fab" style={{ position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: 'var(--fg-2)' }}>
    <button type="button" aria-label="新建聊天" style={{ position: 'absolute', right: 15, bottom: 15, zIndex: 30, display: 'flex', width: 52.5, height: 52.5, alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 9999, background: 'var(--accent)', color: '#fff', '--shadow-color': 'var(--accent-rgb)', boxShadow: 'var(--shadow-tinted)', cursor: 'pointer' }}><Plus size={22.5} strokeWidth={2.5} /></button>
  </div>
}