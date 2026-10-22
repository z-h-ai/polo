import { useState } from 'react'
import { AppWindow, FolderOpen, MoreHorizontal, Send, Trash2, Maximize2, Globe, HardDrive, AlertCircle } from 'lucide-react'

// Skills/Sources list + detail scene. Structure per SkillsListPanel.tsx,
// SourcesListPanel.tsx, SkillInfoPage.tsx and SourceInfoPage.tsx on the
// entity-row / entity-list-badge / Info_Page + Info_Section + Info_Table +
// Info_Markdown + ToolsDataTable + PermissionsDataTable system. Skills and
// sources (metadata, paths, tool lists, permission rows, statuses, markdown)
// are named deterministic fixtures — the real values come from IPC and cannot
// be derived from static source. Root font-size 15px.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// LoadedSkill fixtures: one creator-installed workspace skill (update banner
// + list badge), one project skill (由项目管理 label, no delete) and one
// global skill. alwaysAllow drives the 请求使用的工具 section presence.
const SKILL_CONTENT = [
  [['h2', '用途'], ['p', '每周五读取 polaris 仓库的会话记录与 Git 提交，汇总为本周的工作周报草稿，包含进展、变更与待办。']],
  [['h2', '运行方式'], ['p', '本技能会被以下场景触发：'], ['ul', ['用户在周报发布日请求「生成周报」', '会话中粘贴了本周的提交摘要', '用户手动在 /skills 中运行']]],
  [['h2', '产出格式'], ['ol', ['本周进展（含会话摘要）', '仓库变更（提交与 PR 链接）', '待办清单与建议']]],
  [['p', '所有工具调用都应在 workspace 目录内进行，不要越权访问其他目录。']],
]

const SKILL_CONTENT_REVIEW = [
  [['h2', '审查范围'], ['p', '只审查当前工作树中 src/ 与 tests/ 下的变更文件。']],
  [['h2', '输出要求'], ['ul', ['按严重程度分组的问题列表', '每个问题附建议修复代码片段']]],
]

const skills = [
  {
    slug: 'weekly-report', name: '周报生成器', description: '汇总本周会话与提交，生成周报草稿',
    source: 'workspace', emoji: '📋',
    path: '/Users/douglas/Polo/Workspaces/main/.agents/skills/weekly-report/',
    alwaysAllow: ['read_file', 'run_command'], requiredSources: ['polaris-mcp'],
    content: SKILL_CONTENT,
    creatorInstallation: { version: '1.1.0', artifactId: 'weekly-report', archiveChecksum: 'f8e2c1', lastKnownStatus: 'ok' },
    availableVersion: '1.2.0',
  },
  {
    slug: 'commit-message', name: '提交信息撰写', description: '根据 diff 生成符合规范的提交信息',
    source: 'project', emoji: '✍️',
    path: '/Users/douglas/work/projects/polo/.agents/skills/commit-message/',
    alwaysAllow: ['read_file'], requiredSources: null,
    content: [[['h2', '用法'], ['p', '读取 <code>git diff --staged</code> 输出，按 Conventional Commits 规范生成提交信息。']]],
  },
  {
    slug: 'code-review', name: '代码审查', description: '对变更进行深度代码审查并给出建议',
    source: 'global', emoji: '🔍',
    path: '/Users/douglas/.agents/skills/code-review/',
    alwaysAllow: null, requiredSources: null,
    content: SKILL_CONTENT_REVIEW,
  },
]

// LoadedSource fixtures with per-type fallback icon / EntityListBadge colors.
const SOURCE_STATUS = {
  polaris_mcp: null,               // connected — no status badge
  notion_api: { label: '需要认证', color: 'warning' },
  research_notes: { label: '未测试', color: 'untested' },
}

const SOURCES = [
  {
    slug: 'polaris-mcp', name: 'Polaris MCP', tagline: '项目数据 API 网关', type: 'mcp',
    url: 'ws://192.168.1.100:9100', lastTested: '2 天前',
    tools: [
      { name: 'read_file', description: '读取仓库文件内容', permission: 'allowed' },
      { name: 'write_file', description: '写入或修改仓库文件', permission: 'requires-permission' },
      { name: 'run_command', description: '在仓库内执行命令', permission: 'requires-permission' },
    ],
    permissions: [
      { access: 'blocked', pattern: 'git push --force', comment: '禁止强制推送' },
      { access: 'blocked', pattern: 'rm -rf /root', comment: '危险命令' },
    ],
    guide: [
      [['h2', '快速开始'], ['p', '将 <code>polaris-mcp</code> 添加为数据源后，即可在会话中引用它：']],
      [['ul', ['@polaris-mcp 查询本周提交', '@polaris-mcp 读取 issue #128 状态']]],
      [['h2', '已实现的工具'], ['ol', ['read_file — 只读访问仓库文件', 'run_command — 执行受沙箱限制的命令（需询问）', 'write_file — 修改文件（需询问）']]],
    ],
  },
  {
    slug: 'notion-api', name: 'Notion API', tagline: '以 API 模式访问 Notion 工作区', type: 'api',
    url: 'https://api.notion.com/v1', lastTested: '从不',
    connectionError: '缺少 API token —— 发送要求认证的消息来开始连接。',
    guide: null,
  },
  {
    slug: 'research-notes', name: '研究笔记', tagline: '本地 Markdown 知识库', type: 'local',
    url: '/Users/douglas/Polo/Workspaces/main/data/research', lastTested: '从不',
    guide: null,
  },
]

// ---------------------------------------------------------------------------
// Shared layout helpers (entity-row.tsx / Info_* system, same chrome as the
// automations scene)
// ---------------------------------------------------------------------------

// entity-list-badge.tsx: px-1.5 py-0.5 rounded-full text-[10px]; tints per
// SOURCE_TYPE_CONFIG / SOURCE_STATUS_CONFIG.
function ListBadge({ tint, children }) {
  const styles = {
    project: { background: 'color-mix(in srgb, var(--foreground) 5%, transparent)', color: 'var(--fg-50)' },
    update: { background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)' },
    accent: { background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)' },
    success: { background: 'color-mix(in srgb, var(--success) 10%, transparent)', color: 'var(--success)' },
    info: { background: 'color-mix(in srgb, var(--info) 10%, transparent)', color: 'var(--info)' },
    warning: { background: 'color-mix(in srgb, #f59e0b 10%, transparent)', color: '#b45309' },
    destructive: { background: 'color-mix(in srgb, var(--destructive) 10%, transparent)', color: 'var(--destructive)' },
    untested: { background: 'color-mix(in srgb, var(--foreground) 10%, transparent)', color: 'color-mix(in srgb, var(--foreground) 50%, transparent)' },
  }[tint]
  return <span style={{ flexShrink: 0, padding: '1.875px 5.625px', borderRadius: 999, fontSize: 10, whiteSpace: 'nowrap', lineHeight: 1.5, ...styles }}>{children}</span>
}

// entity-row.tsx EntityRow — same row button metrics as the automations list.
function EntityRow({ icon, title, badges, selected, onClick }) {
  const [hovered, setHovered] = useState(false)
  const background = selected ? 'color-mix(in srgb, var(--foreground) 3%, transparent)' : hovered ? 'color-mix(in srgb, var(--foreground) 2%, transparent)' : 'transparent'
  return (
    <button
      type="button" onClick={onClick}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', width: '100%', alignItems: 'flex-start', gap: 7.5,
        paddingLeft: 7.5, paddingRight: 15, paddingTop: 11.25, paddingBottom: 11.25,
        border: 0, borderRadius: 8, background, color: 'var(--foreground)',
        cursor: 'pointer', textAlign: 'left', transition: 'background-color 75ms',
      }}
    >
      {icon}
      <span style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 2.5 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, fontSize: 13.125, lineHeight: 1.35 }}>{title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3.75, width: '100%', minWidth: 0, color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', fontSize: 11.25 }}>
          {badges}
        </span>
      </span>
    </button>
  )
}

// skill-avatar.tsx / source-avatar.tsx: 32x32 rounded-[4px] ring-border/30
// hero avatar (fluid variant fills the Info_Page.Hero container), sm variant
// is h-4 w-4; emoji glyph at 11px (hero 16px), fallback icon per type.
function SkillIcon({ emoji }) {
  return (
    <span aria-hidden="true" style={{ display: 'flex', width: 15, height: 15, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 4, background: 'var(--muted)', boxShadow: '0 0 0 1px color-mix(in srgb, var(--border) 30%, transparent)', fontSize: 11, lineHeight: 1 }}>{emoji}</span>
  )
}

function HeroSkillIcon({ emoji }) {
  return (
    <span aria-hidden="true" style={{ display: 'flex', width: 32, height: 32, flexShrink: 0, marginTop: 2, alignItems: 'center', justifyContent: 'center', borderRadius: 4, background: 'var(--muted)', boxShadow: '0 0 0 1px color-mix(in srgb, var(--border) 30%, transparent)', fontSize: 16, lineHeight: 1 }}>{emoji}</span>
  )
}

function McpGlyph({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7l7 7-7 7" />
      <path d="M12 7l7 7-7 7" />
    </svg>
  )
}

function SourceIcon({ type, size = 11 }) {
  const Icon = type === 'api' ? Globe : type === 'local' ? HardDrive : McpGlyph
  return (
    <span aria-hidden="true" style={{ display: 'flex', width: 15, height: 15, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 4, background: 'var(--muted)', boxShadow: '0 0 0 1px color-mix(in srgb, var(--border) 30%, transparent)', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)' }}>
      <Icon size={size} />
    </span>
  )
}

function HeroSourceIcon({ type }) {
  const Icon = type === 'api' ? Globe : type === 'local' ? HardDrive : McpGlyph
  return (
    <span aria-hidden="true" style={{ display: 'flex', width: 32, height: 32, flexShrink: 0, marginTop: 2, alignItems: 'center', justifyContent: 'center', borderRadius: 4, background: 'var(--muted)', boxShadow: '0 0 0 1px color-mix(in srgb, var(--border) 30%, transparent)', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)' }}>
      <Icon size={16} />
    </span>
  )
}

// Info_Page.Header — PanelHeader chrome with the MoreHorizontal title menu
// trigger (menu-open scene state renders the StyledDropdown popover).
function InfoPageHeader({ title, menuOpen, onToggleMenu, popover }) {
  return (
    <div className="source-navigator__header" style={{ zIndex: 50 }}>
      <span className="source-navigator__header-title">{title}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 3.75, position: 'relative' }}>
        <button type="button" className="source-navigator__header-button" aria-label="更多选项" onClick={onToggleMenu}>
          <MoreHorizontal size={15} />
        </button>
        {menuOpen && popover}
      </span>
    </div>
  )
}

// StyledDropdown chrome: popover-styled p-1 flex flex-col gap-0.5
// whitespace-nowrap rounded-[8px] bg-background shadow-modal-small min-w-40;
// item relative flex items-center gap-2 px-2 py-1.5 pr-4 text-sm
// rounded-[4px] hover:bg-foreground/[0.03].
function MenuPopover({ items }) {
  return (
    <div
      role="menu"
      style={{
        position: 'absolute', top: '100%', right: 0, marginTop: 4,
        minWidth: 160, padding: 3.75, display: 'flex', flexDirection: 'column', gap: 1.875,
        whiteSpace: 'nowrap', background: 'var(--background)', borderRadius: 8, boxShadow: 'var(--shadow-modal-small)',
        zIndex: 60,
      }}
    >
      {items.map((item, i) => (
        item.sep ? (
          <hr key={i} style={{ height: 1, margin: '3.75px -3.75px', border: 0, background: 'color-mix(in srgb, var(--foreground) 10%, transparent)' }} />
        ) : (
          <button
            key={i} type="button" role="menuitem" disabled={item.disabled}
            style={{
              position: 'relative', display: 'flex', alignItems: 'center', gap: 7.5,
              padding: '5.625px 7.5px 5.625px 7.5px', paddingRight: 15,
              fontSize: 13.125, color: item.destructive && !item.disabled ? 'var(--destructive)' : item.disabled ? 'color-mix(in srgb, var(--foreground) 30%, transparent)' : 'var(--foreground)',
              border: 0, borderRadius: 4, background: 'transparent', cursor: item.disabled ? 'default' : 'pointer', textAlign: 'left',
            }}
          >
            <span style={{ display: 'inline-flex', flexShrink: 0, width: 13.125, height: 13.125 }}>{item.icon}</span>
            <span style={{ flex: 1 }}>{item.label}</span>
          </button>
        )
      ))}
    </div>
  )
}

// Shared menu content — SkillMenu.tsx / SourceMenu.tsx item list. Skills from
// non-workspace sources get the disabled 由项目管理 delete row.
function menuIcon(Icon) { return <Icon size={13.125} strokeWidth={2} /> }

function skillMenuItems(deleteLabel, canDelete) {
  return [
    { icon: menuIcon(AppWindow), label: '在新窗口中打开' },
    { icon: menuIcon(FolderOpen), label: '在 Finder 中显示' },
    { sep: true },
    { icon: menuIcon(Trash2), label: deleteLabel, destructive: true, disabled: !canDelete },
  ]
}

function sourceMenuItems() {
  return [
    { icon: menuIcon(AppWindow), label: '在新窗口中打开' },
    { icon: menuIcon(FolderOpen), label: '在 Finder 中显示' },
    { icon: menuIcon(Send), label: '发送到 Workspace...' },
    { sep: true },
    { icon: menuIcon(Trash2), label: '删除数据源', destructive: true },
  ]
}

// Info_Page.Content: centered column (CHAT_LAYOUT.maxWidth) with fade mask.
const maskFadeY = 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'

function InfoPageContent({ children }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitMaskImage: maskFadeY, maskImage: maskFadeY }}>
      <div style={{ maxWidth: 630, margin: '0 auto', boxSizing: 'border-box', padding: '22.5px 18.75px 37.5px', display: 'flex', flexDirection: 'column', gap: 22.5 }}>
        {children}
      </div>
    </div>
  )
}

// Info_Page.Hero — 32px rounded-[4px] ring-border/30 avatar + name + tagline.
function Hero({ avatar, title, tagline }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11.25 }}>
      {avatar}
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.35, color: 'var(--foreground)' }}>{title}</h2>
        {tagline && <p style={{ margin: 0, marginTop: 1.875, color: 'color-mix(in srgb, var(--foreground) 60%, transparent)', fontSize: 13.125, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tagline}</p>}
      </div>
    </div>
  )
}

// Info_Section: space-y-3 pt-2; header pl-1 with h3 text-base font-semibold
// + muted text-sm description and right actions; card bg-background
// shadow-minimal rounded-[8px].
function InfoSection({ title, description, actions, children }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 11.25, paddingTop: 7.5 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 15, paddingLeft: 3.75 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1.875, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{title}</h3>
          {description && <span style={{ color: 'var(--fg-50)', fontSize: 13.125 }}>{description}</span>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

function InfoCard({ children }) {
  return <div style={{ overflow: 'hidden', borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)' }}>{children}</div>
}

// Info_Table: py-2 wrapper with dl divide-y divide-border/30; row flex
// py-2.5 px-4 text-sm (mt-0.5 in hero), dt 120px text-muted-foreground.
function InfoTable({ rows, footer }) {
  return (
    <InfoCard>
      <div style={{ paddingTop: 7.5, paddingBottom: 7.5 }}>
        <dl style={{ margin: 0 }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'baseline', padding: '9.375px 15px', fontSize: 13.125, borderTop: '1px solid color-mix(in srgb, var(--border) 30%, transparent)' }}>
              <dt style={{ width: 120, flexShrink: 0, color: 'var(--fg-50)' }}>{label}</dt>
              <dd style={{ margin: 0, minWidth: 0, color: 'var(--foreground)' }}>{value}</dd>
            </div>
          ))}
        </dl>
        {footer}
      </div>
    </InfoCard>
  )
}

// EditPopover's EditButton: h-8 px-3 rounded-[6px] bg-background
// shadow-minimal text-foreground/70 hover:text-foreground.
function EditButton() {
  return (
    <button type="button" style={{ display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 11.25px', borderRadius: 6, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', fontSize: 13.125, border: 0, cursor: 'pointer' }}>
      编辑
    </button>
  )
}

// Info_Badge: rounded-[5px] pl-2.5 pr-3 py-1 text-xs font-medium; tinted
// variants use oklch 8% backgrounds + shadow-tinted.
function InfoBadge({ color = 'muted', children }) {
  const styles = {
    muted: { background: 'var(--background)', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', boxShadow: 'var(--shadow-minimal)' },
    success: { background: 'color-mix(in srgb, var(--success) 8%, transparent)', color: 'var(--success)', boxShadow: 'var(--shadow-tinted)' },
    warning: { background: 'color-mix(in srgb, #f59e0b 8%, transparent)', color: '#b45309', boxShadow: 'var(--shadow-tinted)' },
    destructive: { background: 'color-mix(in srgb, var(--destructive) 8%, transparent)', color: 'var(--destructive)', boxShadow: 'var(--shadow-tinted)' },
  }[color] || { background: 'color-mix(in srgb, var(--foreground) 10%, transparent)', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', boxShadow: 'var(--shadow-tinted)' }
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5.625, padding: '3.75px 9.375px 3.75px 11.25px', borderRadius: 5, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', lineHeight: 1.5, ...styles }}>{children}</span>
}

// Info_StatusBadge — allowed/requires-permission/blocked → 允许/询问/已阻止.
function StatusBadge({ status }) {
  if (status === 'allowed') return <InfoBadge color="success">允许</InfoBadge>
  if (status === 'requires-permission') return <InfoBadge color="warning">询问</InfoBadge>
  return <InfoBadge color="destructive">已阻止</InfoBadge>
}

// Info_Markdown — statically rendered markdown blocks (the Renderer renders
// skill.content / guide.raw through markdown-html); maxHeight scroll like the
// source (540) with the hover-reveal Maximize2 fullscreen button.
function MarkdownView({ blocks }) {
  const [hovered, setHovered] = useState(false)
  const blockStyle = { margin: 0, paddingBottom: 7.5, fontSize: 13.125, lineHeight: 1.55, color: 'var(--foreground)' }
  const richStyle = { margin: 0, paddingBottom: 7.5, paddingLeft: 26.25, fontSize: 13.125, lineHeight: 1.65, color: 'var(--foreground)' }
  return (
    <div
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ position: 'relative', padding: '7.5px 15px 3.75px', maxHeight: 540, overflowY: 'auto' }}
    >
      {blocks.map((section, i) => (
        <div key={i}>
          {section.map(([tag, text], j) => {
            if (tag === 'h2') return <h3 key={j} style={{ margin: 0, paddingBottom: 7.5, fontSize: 13.125, fontWeight: 600, color: 'var(--foreground)' }}>{text}</h3>
            if (tag === 'ul' || tag === 'ol') {
              return (
                <ul key={j} style={richStyle}>
                  {text.map((item, k) => <li key={k} style={{ paddingBottom: 2.5 }}>{item}</li>)}
                </ul>
              )
            }
            return <p key={j} style={blockStyle}>{text}</p>
          })}
        </div>
      ))}
      {/* hover-reveal fullscreen button */}
      <button
        type="button" title="全屏查看"
        style={{
          position: 'absolute', top: 7.5, right: 7.5, display: hovered ? 'flex' : 'none',
          width: 26.25, height: 26.25, alignItems: 'center', justifyContent: 'center',
          padding: 0, border: 0, borderRadius: 6, background: 'color-mix(in srgb, var(--background) 80%, transparent)',
          backdropFilter: 'blur(1px)', color: 'color-mix(in srgb, var(--foreground) 50%, transparent)',
          boxShadow: 'var(--shadow-minimal)', cursor: 'pointer',
        }}
      >
        <Maximize2 size={13.125} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skills list + detail
// ---------------------------------------------------------------------------

export function SourceSkillsList({ selectedSlug = 'weekly-report' }) {
  return (
    <div data-route="resources/skills/list" style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', boxSizing: 'border-box', padding: 7.5, borderRadius: 7.5 }}>
      {skills.map(skill => (
        <EntityRow
          key={skill.slug}
          icon={<SkillIcon emoji={skill.emoji} />}
          title={skill.name}
          selected={skill.slug === selectedSlug}
          onClick={() => {}}
          badges={
            <>
              {skill.source === 'project' && <ListBadge tint="project">项目</ListBadge>}
              {skill.availableVersion && <ListBadge tint="update">有可用的安全版本 {skill.availableVersion}</ListBadge>}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.25 }}>{skill.description}</span>
            </>
          }
        />
      ))}
    </div>
  )
}

export function SourceSkillDetail({ menuOpen = false }) {
  const [open, setOpen] = useState(menuOpen)
  const skill = skills[0]
  const canDelete = skill.source === 'workspace'
  const deleteLabel = canDelete ? '删除技能' : '由项目管理'
  const formatPath = path => {
    const i = path.indexOf('/skills/')
    return i !== -1 ? path.slice(i + 1) : path
  }
  return (
    <div data-route="resources/skills/detail" style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, flexDirection: 'column', background: 'var(--background)', color: 'var(--foreground)' }}>
      <InfoPageHeader
        title={skill.name}
        menuOpen={open}
        onToggleMenu={() => setOpen(o => !o)}
        popover={<MenuPopover items={skillMenuItems(deleteLabel, canDelete)} />}
      />
      <InfoPageContent>
        {skill.availableVersion && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7.5, borderRadius: 8, border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)', background: 'color-mix(in srgb, var(--accent) 5%, transparent)', padding: '7.5px 11.25px', fontSize: 13.125 }}>
            <span style={{ marginRight: 'auto' }}>有可用的安全版本 {skill.availableVersion}</span>
            <button type="button" style={{ padding: '3.75px 9.375px', borderRadius: 6, border: 0, background: 'var(--accent)', color: 'var(--accent-foreground)', fontWeight: 500, cursor: 'pointer' }}>更新</button>
            <button type="button" style={{ padding: '3.75px 9.375px', borderRadius: 6, border: 0, background: 'transparent', color: 'var(--fg-50)', cursor: 'pointer' }}>忽略这个版本</button>
          </div>
        )}

        <Hero avatar={<HeroSkillIcon emoji={skill.emoji} />} title={skill.name} tagline={skill.description} />

        <InfoSection title="元数据" actions={<EditButton />}>
          <InfoTable rows={[
            ['标识符', skill.slug],
            ['名称', skill.name],
            ['描述', skill.description],
            ['数据源', skill.source === 'project' ? '项目 (.agents/skills/)' : skill.source === 'global' ? '全局 (~/.agents/skills/)' : 'Workspace'],
            ['位置', <button key="loc" type="button" style={{ border: 0, padding: 0, background: 'none', color: 'var(--foreground)', cursor: 'pointer', textAlign: 'left', fontSize: 13.125 }} onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline' }} onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none' }}>{formatPath(skill.path)}</button>],
            ...(skill.requiredSources ? [['建议的 Source（不会自动启用）', skill.requiredSources.join(', ')]] : []),
          ]} />
        </InfoSection>

        {skill.alwaysAllow && (
          <InfoSection title="Skill 请求使用的工具">
            <InfoCard>
              <div style={{ padding: '11.25px 15px' }}>
                <p style={{ margin: 0, marginBottom: 11.25, fontSize: 11.25, color: 'var(--fg-50)' }}>仅作为建议性元数据展示。工具访问仍由当前权限模式和用户审批决定。</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5.625 }}>
                  {skill.alwaysAllow.map(tool => (
                    <code key={tool} style={{ borderRadius: 4, background: 'color-mix(in srgb, var(--foreground) 5%, transparent)', padding: '3.75px 7.5px', fontSize: 11.25, color: 'color-mix(in srgb, var(--foreground) 80%, transparent)', fontFamily: 'var(--font-mono)' }}>{tool}</code>
                  ))}
                </div>
              </div>
            </InfoCard>
          </InfoSection>
        )}

        <InfoSection title="说明" actions={<EditButton />}>
          <MarkdownView blocks={skill.content} />
        </InfoSection>
      </InfoPageContent>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sources list + detail
// ---------------------------------------------------------------------------

const SOURCE_TYPE_LABEL = { mcp: 'MCP', api: 'API', local: '本地' }

export function SourceSourcesList({ selectedSlug = 'polaris-mcp' }) {
  return (
    <div data-route="resources/sources/list" style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', boxSizing: 'border-box', padding: 7.5, borderRadius: 7.5 }}>
      {SOURCES.map(source => {
        const status = SOURCE_STATUS[source.slug]
        return (
          <EntityRow
            key={source.slug}
            icon={<SourceIcon type={source.type} />}
            title={source.name}
            selected={source.slug === selectedSlug}
            onClick={() => {}}
            badges={
              <>
                <ListBadge tint={{ mcp: 'accent', api: 'success', local: 'info' }[source.type]}>{SOURCE_TYPE_LABEL[source.type]}</ListBadge>
                {status && <ListBadge tint={status.color}>{status.label}</ListBadge>}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.25 }}>{source.tagline}</span>
              </>
            }
          />
        )
      })}
    </div>
  )
}

export function SourceSourceDetail({ menuOpen = false }) {
  const [open, setOpen] = useState(menuOpen)
  const source = SOURCES[0]
  return (
    <div data-route="resources/sources/detail" style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, flexDirection: 'column', background: 'var(--background)', color: 'var(--foreground)' }}>
      <InfoPageHeader
        title={source.name}
        menuOpen={open}
        onToggleMenu={() => setOpen(o => !o)}
        popover={<MenuPopover items={sourceMenuItems()} />}
      />
      <InfoPageContent>
        <Hero avatar={<HeroSourceIcon type={source.type} />} title={source.name} tagline={source.tagline} />

        <InfoSection title="连接" description="服务器 URL 和连接状态。" actions={<EditButton />}>
          <InfoTable
            rows={[
              ['类型', source.type.toUpperCase()],
              ['URL', <button key="url" type="button" style={{ border: 0, padding: 0, background: 'none', color: 'var(--foreground)', cursor: 'pointer', textAlign: 'left', fontSize: 13.125, display: 'block', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline' }} onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none' }}>{source.url}</button>],
              ['上次测试', source.lastTested],
            ]}
            footer={
              source.connectionError ? (
                <div style={{ padding: '7.5px 15px', borderTop: '1px solid color-mix(in srgb, var(--border) 30%, transparent)', background: 'color-mix(in srgb, var(--destructive) 5%, transparent)' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7.5, fontSize: 13.125, color: 'var(--destructive)' }}>
                    <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1.875 }} />
                    <span>{source.connectionError}</span>
                  </div>
                </div>
              ) : null
            }
          />
        </InfoSection>

        <InfoSection title="工具" description="此服务器暴露的操作。" actions={<EditButton />}>
          <InfoCard>
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.125 }}>
                <thead>
                  <tr style={{ color: 'var(--fg-50)' }}>
                    <th scope="col" style={{ textAlign: 'left', fontWeight: 500, padding: '5.625px 7.5px 5.625px 9.375px' }}>访问</th>
                    <th scope="col" style={{ textAlign: 'left', fontWeight: 500, padding: '5.625px 7.5px 5.625px 9.375px' }}>工具</th>
                    <th scope="col" style={{ textAlign: 'left', fontWeight: 500, padding: '5.625px 7.5px 5.625px 9.375px' }}>描述</th>
                  </tr>
                </thead>
                <tbody>
                  {source.tools.map(tool => (
                    <tr key={tool.name} style={{ borderTop: '1px solid color-mix(in srgb, var(--border) 30%, transparent)' }}>
                      <td style={{ padding: '5.625px 7.5px 5.625px 9.375px' }}><StatusBadge status={tool.permission} /></td>
                      <td style={{ padding: '5.625px 7.5px 5.625px 9.375px' }}><InfoBadge>{tool.name}</InfoBadge></td>
                      <td style={{ padding: '5.625px 7.5px 5.625px 9.375px', minWidth: 0, color: 'var(--foreground)' }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.description}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </InfoCard>
        </InfoSection>

        <InfoSection title="权限" description="探索模式的访问规则。" actions={<EditButton />}>
          <InfoCard>
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.125 }}>
                <thead>
                  <tr style={{ color: 'var(--fg-50)' }}>
                    <th scope="col" style={{ textAlign: 'left', fontWeight: 500, padding: '5.625px 7.5px 5.625px 9.375px' }}>访问</th>
                    <th scope="col" style={{ textAlign: 'left', fontWeight: 500, padding: '5.625px 7.5px 5.625px 9.375px' }}>模式</th>
                    <th scope="col" style={{ textAlign: 'left', fontWeight: 500, padding: '5.625px 7.5px 5.625px 9.375px' }}>注释</th>
                  </tr>
                </thead>
                <tbody>
                  {source.permissions.map(row => (
                    <tr key={row.pattern} style={{ borderTop: '1px solid color-mix(in srgb, var(--border) 30%, transparent)' }}>
                      <td style={{ padding: '5.625px 7.5px 5.625px 9.375px' }}><StatusBadge status="blocked" /></td>
                      <td style={{ padding: '5.625px 7.5px 5.625px 9.375px' }}><InfoBadge>{row.pattern}</InfoBadge></td>
                      <td style={{ padding: '5.625px 7.5px 5.625px 9.375px', color: 'var(--foreground)' }}>{row.comment}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </InfoCard>
        </InfoSection>

        <InfoSection title="文档" description="智能体的上下文和指南。" actions={<EditButton />}>
          <MarkdownView blocks={source.guide} />
        </InfoSection>
      </InfoPageContent>
    </div>
  )
}