import { useState } from 'react'
import { AlertTriangle, Archive, ChevronDown, Download, FileArchive, Globe2, Link2, MoreHorizontal, PackagePlus, Plus, RefreshCw, ShieldAlert, Trash2, Upload, X, XCircle } from 'lucide-react'

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
    <section role="dialog" aria-modal="true" aria-labelledby="org-manage-title" style={{ position: 'relative', display: 'flex', width: 'calc(100% - 32px)', maxWidth: 720, maxHeight: '85%', boxSizing: 'border-box', flexDirection: 'column', gap: 15, padding: 22.5, borderRadius: 10, border: `1px solid ${border50}`, background: 'var(--background)', boxShadow: 'var(--shadow-modal-small)', color: 'var(--foreground)' }}>
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
        {tab === 'artifacts' ? <ArtifactsPanel /> : tab === 'members' ? <MemberList /> : <InvitationList />}
      </div>
    </section>
  </div>
}

// ---------------------------------------------------------------------------
// Artifacts tab — CreatorArtifactsPanel.tsx static translation. Layout
// `grid min-h-[440px] gap-4 pt-2 md:grid-cols-[220px_minmax(0,1fr)]`; the
// aside lists 作品 with the create-artifact box and scrollable rows, the
// section renders the selected skill's full detail. Every artifact,
// workspace target, version, checksum, changelog, file tree, reference and
// validation issue is a named deterministic fixture (IPC data at runtime).
// ---------------------------------------------------------------------------

const FixtureArtifacts = [
  { id: 'a1', type: 'skill', slug: 'polaris-skill', name: null, displayIcon: { kind: 'emoji', value: '🧭' }, status: 'published', latestPublishedVersion: 'v1.2.0', summary: '生成北极星周报目录结构的 Creator Skill' },
  { id: 'a2', type: 'web_app', slug: 'report-web', name: 'Report Web', displayIcon: { kind: 'emoji', value: '📊' }, status: 'published', latestPublishedVersion: null, summary: '周报在线查看应用' },
]

const FixtureVersions = [
  { id: 'v1', version: 'v1.2.0', status: 'published', changelog: '首次发布：周报目录骨架与时区修复提取', archiveChecksum: 'sha256 ab12cd34ef5678901234567890abcdef', contentDigest: 'digest 9f3a2c1e7b4d8f6a', sizeBytes: 24800, publishedByUserId: 'u_Qm8y2p', publishedAt: '2 月 3 日 09:12' },
  { id: 'v2', version: 'v1.3.0-rc', status: 'validating', changelog: '', archiveChecksum: null, contentDigest: null },
]

const FixtureIssues = [
  { severity: 'error', path: 'SKILL.md', field: null, code: 'invalid_skill_content', message: 'SKILL.md 正文或 frontmatter 无效。' },
  { severity: 'warning', path: 'references/guide.md', field: null, code: 'packaging_noise_removed', message: '已忽略已知的打包噪音文件。' },
]

const SkillContent = `---
name: polaris-skill
description: 生成北极星周报目录结构的 Creator Skill
version: 1.2.0
icon: 🧭
---

按照提交记录整理 changelog 条目结构，并按周生成周报骨架。

## 用法

\`\`\`bash
polo run polaris-skill week
\`\`\`
`

const FileTree = [
  { path: 'SKILL.md', size: 1240 },
  { path: 'icon.png', size: 96 },
  { path: 'references/guide.md', size: 4200 },
  { path: 'references/journal.tpl.hbs', size: 1520 },
]

function SelectTrigger({ value }) {
  return <button type="button" style={{ display: 'flex', width: '100%', height: 33.75, alignItems: 'center', justifyContent: 'space-between', gap: 7.5, padding: '0 11.25px', boxSizing: 'border-box', borderRadius: 6, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', background: 'var(--background)', color: 'var(--foreground)', fontSize: 13.125, cursor: 'pointer' }}>
    <span>{value}</span><ChevronDown size={13.125} style={{ color: var50 }} />
  </button>
}

function Label({ children }) {
  return <span style={{ display: 'block', fontSize: 11.25, fontWeight: 600, color: 'var(--foreground)', marginBottom: 5.625 }}>{children}</span>
}

function ArtifactRow({ item, selected }) {
  const isSkill = item.type === 'skill'
  return <button type="button" aria-pressed={selected} style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '7.5px 11.25px', borderRadius: 8, border: selected ? '1px solid color-mix(in srgb, var(--accent) 40%, transparent)' : '1px solid transparent', background: selected ? 'color-mix(in srgb, var(--accent) 5%, transparent)' : 'transparent', textAlign: 'left', cursor: 'pointer', color: 'var(--foreground)' }}>
    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.125, fontWeight: 500 }}>
      {item.displayIcon.kind === 'emoji' ? `${item.displayIcon.value} ` : ''}{item.name || item.slug}
    </span>
    <span style={{ display: 'flex', alignItems: 'center', gap: 3.75, marginTop: 1.875, fontSize: 11, color: var50 }}>
      {isSkill ? <FileArchive size={11.25} /> : <Globe2 size={11.25} />}
      <span>{isSkill ? 'Skill' : 'Web App'}</span>
      <span>·</span>
      <span>{item.latestPublishedVersion ?? `已发布`}</span>
    </span>
  </button>
}

function DetailShell({ children }) {
  return <section data-testid="creator-artifact-detail" style={{ minWidth: 0, maxHeight: '58vh', overflowY: 'auto', boxSizing: 'border-box', borderRadius: 11.25, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', padding: 15, display: 'flex', flexDirection: 'column', gap: 18.75 }}>{children}</section>
}

function MetadataRow({ label, value }) {
  return <div style={{ borderRadius: 8, background: 'color-mix(in srgb, var(--foreground) 3.5%, transparent)', padding: 11.25 }}>
    <p style={{ margin: 0, color: var50, fontSize: 11.25, lineHeight: 1.4286 }}>{label}</p>
    <p style={{ margin: '3.75px 0 0', wordBreak: 'break-all', fontSize: 11.25, lineHeight: 1.4286 }}>{value}</p>
  </div>
}

function ArtifactsPanel() {
  const target = { name: 'polo-demo', path: '/workspace/polo-demo', writable: true }
  return <div data-testid="creator-artifacts-panel" style={{ display: 'grid', minHeight: 440, gap: 15, paddingTop: 7.5, gridTemplateColumns: '220px minmax(0, 1fr)' }}>
    {/* -------- aside -------- */}
    <aside style={{ display: 'flex', flexDirection: 'column', gap: 11.25, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 13.125, fontWeight: 500 }}>作品</h3>
        <button type="button" aria-label="刷新" style={iconBtn}><RefreshCw size={13.125} /></button>
      </div>
      {/* create-artifact box — select closed on Skill, slug fixture, create affordance */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7.5, boxSizing: 'border-box', borderRadius: 11.25, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', padding: 11.25 }}>
        <Label>作品类型</Label>
        <SelectTrigger value="Skill" />
        <Label>Skill slug</Label>
        <input readOnly defaultValue="my-skill" aria-label="Skill slug" style={inputSm} />
        <button type="button" disabled={false} style={{ display: 'inline-flex', height: 30, alignItems: 'center', justifyContent: 'center', gap: 5.625, padding: '0 11.25px', border: 0, borderRadius: 6, background: 'var(--foreground)', color: 'var(--background)', fontSize: 11.25, fontWeight: 500, cursor: 'pointer', width: '100%' }}><PackagePlus size={13.125} />新建 Skill 草稿</button>
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3.75 }}>
        {FixtureArtifacts.map(item => <ArtifactRow key={item.id} item={item} selected={item.id === 'a1'} />)}
      </div>
    </aside>

    {/* -------- detail — selected skill fixture (polaris-skill) -------- */}
    <DetailShell>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 11.25 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 18.75, fontWeight: 600 }}>polaris-skill</h2>
          <p style={{ margin: '3.75px 0 0', fontSize: 13.125, color: var50, lineHeight: 1.4286 }}>生成北极星周报目录结构的 Creator Skill</p>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3.75, marginTop: 7.5, borderRadius: 9999, background: 'color-mix(in srgb, var(--foreground) 5%, transparent)', padding: '1.875px 7.5px', fontSize: 11, color: var50 }}><FileArchive size={11.25} />Skill</span>
        </div>
        <button type="button" aria-label="下架" style={iconBtn}><Archive size={15} /></button>
      </header>

      {/* published version + install box — bg-foreground/[0.035] */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11.25, boxSizing: 'border-box', borderRadius: 11.25, background: 'color-mix(in srgb, var(--foreground) 3.5%, transparent)', padding: 15 }}>
        <div style={{ display: 'grid', gap: 11.25, gridTemplateColumns: '160px minmax(0, 1fr)' }}>
          <SelectTrigger value="v1.2.0" />
          <div style={{ minWidth: 0, fontSize: 11.25, color: var50 }}>
            <p style={{ margin: 0 }}>首次发布：周报目录骨架与时区修复提取</p>
            <p style={{ margin: '3.75px 0 0', fontFamily: 'var(--font-mono)' }}>sha256 ab12cd34ef5678901234567890abcdef</p>
            <p style={{ margin: '3.75px 0 0', fontFamily: 'var(--font-mono)' }}>digest 9f3a2c1e7b4d8f6a</p>
            <p style={{ margin: '3.75px 0 0' }}>包大小：24800 字节</p>
          </div>
        </div>
        <div style={{ boxSizing: 'border-box', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--border) 50%, transparent)', padding: '7.5px 11.25px', fontSize: 11.25 }}>
          <strong>{target.name}</strong>
          <span style={{ marginLeft: 7.5, wordBreak: 'break-all', color: var50 }}>{target.path}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7.5 }}>
          <button type="button" disabled={false} style={{ display: 'inline-flex', height: 33.75, alignItems: 'center', gap: 5.625, padding: '0 15px', border: 0, borderRadius: 8, background: 'var(--foreground)', color: 'var(--background)', fontSize: 13.125, fontWeight: 500, cursor: 'pointer' }}><Download size={15} />安装</button>
        </div>
      </div>

      {/* draft version box — 版本 1.3.0-rc, 校验中, choose-zip affordance */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11.25, boxSizing: 'border-box', borderRadius: 11.25, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', padding: 15 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 13.125, fontWeight: 500 }}>版本 v1.3.0-rc</h3>
            <p style={{ margin: '3.75px 0 0', fontSize: 11.25, color: var50 }}>校验中</p>
          </div>
          <button type="button" aria-label="删除版本" style={{ ...iconBtn, color: 'var(--destructive)' }}><Trash2 size={15} /></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7.5 }}>
          <label style={{ display: 'inline-flex', cursor: 'pointer', alignItems: 'center', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', padding: '7.5px 11.25px', fontSize: 13.125, color: 'var(--foreground)' }}><Upload size={15} />选择 ZIP 并上传</label>
        </div>
      </div>

      {/* validation issues — error + amber warning branches */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7.5 }}>
        {FixtureIssues.map((issue, index) => (
          <div key={`${issue.code}-${issue.path}-${index}`} style={{ display: 'flex', gap: 7.5, boxSizing: 'border-box', borderRadius: 8, border: issue.severity === 'error' ? '1px solid color-mix(in srgb, var(--destructive) 20%, transparent)' : '1px solid rgba(245,158,11,.2)', background: issue.severity === 'error' ? 'color-mix(in srgb, var(--destructive) 5%, transparent)' : 'rgba(245,158,11,.05)', padding: '7.5px 11.25px', fontSize: 11.25 }}>
            {issue.severity === 'error' ? <XCircle size={13.125} style={{ marginTop: 1.875, flexShrink: 0, color: 'var(--destructive)' }} /> : <AlertTriangle size={13.125} style={{ marginTop: 1.875, flexShrink: 0, color: '#b45309' }} />}
            <span style={{ color: issue.severity === 'error' ? 'var(--destructive)' : '#b45309' }}>
              <strong>{issue.path}</strong>{issue.field ? ` · ${issue.field}` : ''}
              {' — '}{issue.message}
            </span>
          </div>
        ))}
      </div>

      {/* metadata grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 7.5, fontSize: 11.25 }}>
        <MetadataRow label="建议的 Source（不会自动启用）" value="github" />
        <MetadataRow label="请求使用的工具（仅建议，不授权）" value="bash:*, write, read" />
        <MetadataRow label="发布人" value="u_Qm8y2p" />
        <MetadataRow label="发布时间" value="2 月 3 日 09:12" />
      </div>

      {/* SKILL.md */}
      <details style={{ borderRadius: 11.25, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', boxSizing: 'border-box' }}>
        <summary style={{ cursor: 'pointer', padding: '11.25px 15px', fontSize: 13.125, fontWeight: 500, color: 'var(--foreground)' }}>SKILL.md</summary>
        <pre style={{ margin: 0, maxHeight: 270, overflowY: 'auto', boxSizing: 'border-box', whiteSpace: 'pre-wrap', borderTop: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', padding: 15, fontSize: 11.25, lineHeight: 1.4286, color: 'color-mix(in srgb, var(--foreground) 85%, transparent)', fontFamily: 'var(--font-mono)' }}>{SkillContent}</pre>
      </details>

      {/* files */}
      <details style={{ borderRadius: 11.25, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', boxSizing: 'border-box' }}>
        <summary style={{ cursor: 'pointer', padding: '11.25px 15px', fontSize: 13.125, fontWeight: 500, color: 'var(--foreground)' }}>文件（{FileTree.length}）</summary>
        <div style={{ maxHeight: 210, overflowY: 'auto', boxSizing: 'border-box', borderTop: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', padding: 11.25, fontFamily: 'var(--font-mono)', fontSize: 11.25 }}>
          {FileTree.map(file => (
            <div key={file.path} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 11.25, padding: '3.75px 0' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.path}</span>
              <span style={{ marginLeft: 'auto', flexShrink: 0, color: var50 }}>{file.size} B</span>
              {file.path.startsWith('references/') ? (
                <button type="button" style={{ flexShrink: 0, border: 0, borderRadius: 4, padding: '1.875px 7.5px', background: 'transparent', color: 'var(--accent)', fontSize: 11.25, cursor: 'pointer' }}>纯文本预览</button>
              ) : null}
            </div>
          ))}
        </div>
      </details>

      {/* revoke rows — published versions owned by the authenticating admin */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, boxSizing: 'border-box', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', padding: 11.25 }}>
        <ShieldAlert size={15} style={{ color: var50 }} />
        <span style={{ fontSize: 13.125 }}>v1.2.0</span>
        <input readOnly defaultValue="" placeholder="必填撤销原因" style={{ marginLeft: 'auto', maxWidth: 240, height: 30, boxSizing: 'border-box', padding: '0 11.25px', borderRadius: 6, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', background: 'var(--background)', color: 'var(--foreground)', fontSize: 11.25, outline: 'none' }} />
        <button type="button" disabled style={{ display: 'inline-flex', height: 30, alignItems: 'center', gap: 5.625, padding: '0 11.25px', border: '1px solid color-mix(in srgb, var(--foreground) 15%, transparent)', borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 12, fontWeight: 500, cursor: 'not-allowed', opacity: 0.4 }}>撤销</button>
      </div>
    </DetailShell>
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
const var50 = 'var(--fg-50)'
// button outline sm: h-8 px-3 text-xs border-foreground/15, gap-2.
const outlineButton = { display: 'inline-flex', height: 30, alignItems: 'center', gap: 7.5, padding: '0 11.25px', border: '1px solid color-mix(in srgb, var(--foreground) 15%, transparent)', borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 12, fontWeight: 500, flexShrink: 0 }
const iconBtn = { display: 'inline-flex', width: 26.25, height: 26.25, alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: 'var(--fg-50)', cursor: 'pointer' }
const inputSm = { width: '100%', height: 30, boxSizing: 'border-box', padding: '0 11.25px', borderRadius: 6, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', background: 'var(--background)', color: 'var(--foreground)', fontSize: 11.25, outline: 'none' }
