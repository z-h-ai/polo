import { useState } from 'react'
import { Link2, MoreHorizontal, Plus, X } from 'lucide-react'

// OrganizationManagementDialog.tsx rendered on the dialog.tsx skeleton:
// overlay > content (sm:max-w-3xl = 675px at the 15px root, max-h-[85vh],
// rounded-[10px], gap-4 p-6, shadow-modal-small) with a ScreenHeaderBar-style
// title row and Tabs. creator_space orgs get three tabs (作品/成员/邀请),
// enterprise two (成员/邀请). The invitation tab title carries the active
// count suffix ` (N)`. Member/invitation identities are named deterministic
// fixtures — they come from IPC at runtime.
export function SourceOrganizationManage({ state = 'members' }) {
  const [tab, setTab] = useState(state === 'artifacts' ? 'artifacts' : state === 'invitations' ? 'invitations' : 'members')
  const tabs = [['artifacts', '作品'], ['members', '成员'], ['invitations', '邀请 (1)']]
  const visibleTabs = tab === 'artifacts' || state === 'artifacts' ? tabs : tabs.filter(([id]) => id !== 'artifacts')
  const close = () => {}
  return <div data-route="organization/manage" style={{ position: 'relative', display: 'grid', width: '100%', height: '100%', minHeight: 0, placeItems: 'center', background: 'rgba(0,0,0,.5)', boxSizing: 'border-box', padding: 15 }}>
    <section role="dialog" aria-modal="true" aria-labelledby="org-manage-title" style={{ position: 'relative', display: 'flex', width: 'calc(100% - 32px)', maxWidth: 675, maxHeight: '85%', boxSizing: 'border-box', flexDirection: 'column', gap: 15, padding: 22.5, borderRadius: 10, border: `1px solid ${border50}`, background: 'var(--background)', boxShadow: 'var(--shadow-modal-small)', color: 'var(--foreground)' }}>
      <button type="button" onClick={close} aria-label="关闭" style={{ position: 'absolute', top: 15, right: 15, display: 'grid', width: 15, height: 15, padding: 0, placeItems: 'center', border: 0, borderRadius: 2, background: 'transparent', color: 'var(--foreground)', opacity: .7 }}><X size={15} /></button>
      <header style={{ display: 'flex', alignItems: 'center', gap: 11.25 }}>
        <h1 id="org-manage-title" style={{ margin: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 16.875, fontWeight: 600 }}>Polo 工作室</h1>
        <button type="button" style={outlineButton}><Plus size={13.125} />生成邀请</button>
      </header>
      <nav role="tablist" aria-label="组织管理" style={{ display: 'flex', alignItems: 'center', gap: 3.75, borderBottom: `1px solid ${border50}` }}>
        {visibleTabs.map(([id, label]) => {
          const selected = id === tab
          return <button key={id} type="button" role="tab" aria-selected={selected} onClick={() => setTab(id)} style={{ padding: '7.5px 11.25px', marginBottom: -1, border: 0, borderBottom: `2px solid ${selected ? 'var(--foreground)' : 'transparent'}`, background: 'transparent', color: selected ? 'var(--foreground)' : 'var(--fg-50)', fontSize: 13.125, fontWeight: 500, cursor: 'pointer' }}>{label}</button>
        })}
      </nav>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {tab === 'artifacts' ? <ArtifactList /> : tab === 'members' ? <MemberList /> : <InvitationList />}
      </div>
    </section>
  </div>
}

// creatorSkills.artifacts tab: the published-app grid, one card per artifact
// fixture.
function ArtifactList() {
  const artifacts = [
    { id: 'chart-kit', name: 'Chart Kit', status: '已安装' },
    { id: 'doc-sprint', name: 'Doc Sprint', status: '运行中' },
  ]
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 11.25 }}>
    {artifacts.map(artifact => <div key={artifact.id} style={{ padding: 15, border: `1px solid ${border50}`, borderRadius: 11.25, background: 'var(--fg-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7.5 }}>
        <span style={{ display: 'grid', width: 30, height: 30, placeItems: 'center', borderRadius: 8.25, background: 'linear-gradient(135deg,#0ea5e9,#4f46e5)', color: '#fff', fontSize: 13.125, fontWeight: 600 }}>{artifact.name.charAt(0)}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.125, fontWeight: 500 }}>{artifact.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 11.25 }}>
        <span style={{ color: 'var(--fg-50)', fontSize: 11 }}>{artifact.status}</span>
        <button type="button" style={{ border: 0, background: 'transparent', color: 'var(--fg-50)', cursor: 'pointer' }} aria-label="更多选项"><MoreHorizontal size={13.125} /></button>
      </div>
    </div>)}
  </div>
}

// Members tab: name + role line + right-side actions from the i18n keys
// (移除成员/暂停成员 render in the row menu; the static fixture shows the
// 更多 trigger only).
function MemberList() {
  const members = [
    { id: 'u1', name: 'Polo User', role: '所有者 · 你' },
    { id: 'u2', name: 'Lin Wei', role: '成员' },
  ]
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7.5 }}>
    {members.map(member => <div key={member.id} style={{ display: 'flex', alignItems: 'center', gap: 11.25, padding: '9.375px 11.25px', borderRadius: 8, background: 'var(--fg-2)' }}>
      <span style={{ display: 'grid', width: 26.25, height: 26.25, flexShrink: 0, placeItems: 'center', borderRadius: 9999, background: 'var(--fg-5)', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', fontSize: 11.25, fontWeight: 500 }}>{member.name.charAt(0)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.125, fontWeight: 500 }}>{member.name}</div>
        <div style={{ color: 'var(--fg-50)', fontSize: 11.25 }}>{member.role}</div>
      </div>
      <button type="button" aria-label="更多选项" style={{ border: 0, background: 'transparent', color: 'var(--fg-50)', cursor: 'pointer' }}><MoreHorizontal size={15} /></button>
    </div>)}
  </div>
}

// Invitations tab: the pending invitation row plus the source's empty-state
// copy when the list has no rows (linkOnlyShownOnce warning belongs to the
// create-link flow, not the list).
function InvitationList() {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7.5 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 11.25, padding: '9.375px 11.25px', borderRadius: 8, background: 'var(--fg-2)' }}>
      <span style={{ display: 'grid', width: 26.25, height: 26.25, flexShrink: 0, placeItems: 'center', borderRadius: 9999, background: 'var(--fg-5)', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)' }}><Link2 size={13.125} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.125, fontWeight: 500 }}>公开加入链接</div>
        <div style={{ color: 'var(--fg-50)', fontSize: 11.25 }}>今天生成 · 未使用</div>
      </div>
      <button type="button" style={outlineButton}>复制链接</button>
    </div>
    <p style={{ margin: 0, color: 'var(--fg-50)', fontSize: 13.125 }}>还没有邀请。</p>
  </div>
}

const border50 = 'color-mix(in srgb, var(--border) 50%, transparent)'
// button outline sm: h-8 px-3 text-xs border-foreground/15, gap-2.
const outlineButton = { display: 'inline-flex', height: 30, alignItems: 'center', gap: 7.5, padding: '0 11.25px', border: '1px solid color-mix(in srgb, var(--foreground) 15%, transparent)', borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 12, fontWeight: 500, flexShrink: 0 }
