import { Check, ChevronRight, File, FileText, Folder, FolderOpen, Monitor } from 'lucide-react'

// Session info popover (right-click → 会话信息 → open) plus the file viewer
// panel and its empty state — static translations of SessionInfoPopover.tsx,
// FileViewer.tsx and the scrubbed-empty branch. The session title is a named
// deterministic fixture (无标题); the file tree, expand/collapse state and
// the selected path are fixtures too — IPC (open-with-fm, reveal paths) stays
// unwired. Copy follows zh-Hans keys; `${fileManager}` renders as 访达 per the
// locale's configuration placeholder. Root font-size 15px.

const muted = 'var(--fg-50)'
const fg5 = 'color-mix(in srgb, var(--foreground) 5%, transparent)'
const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'

// Convenience: `--font-mono` is resolved by base CSS fonts section on the
// whole document; this override keeps the demo copy self-contained.

// ---------------------------------------------------------------------------
// File tree — fixture: polaris-skill session, scripts folder expanded,
// templates collapsed, SKILL.md selected. Connector line at left-[13px]
// matches ml-[13px] column spacing.
// ---------------------------------------------------------------------------

const fileNode = color => ({ width: 13.125, height: 13.125, flexShrink: 0, color })

function FileRow({ name, depth, selected, onSelectRole }) {
  return <div role={onSelectRole ? 'button' : undefined} aria-selected={selected} style={{ display: 'flex', alignItems: 'center', gap: 5.625, padding: '3.75px 9.375px', cursor: onSelectRole ? 'pointer' : 'default', fontSize: 12.75, lineHeight: 1.4118, color: 'var(--foreground)', background: selected ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent', borderRadius: 6 }}>
    <span style={{ width: 13.125, flexShrink: 0 }} />
    <File {...fileNode(muted)} />
    <span style={{ marginLeft: depth * 11.25 }} />
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
  </div>
}

function FolderRow({ name, depth, expanded, actions }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 5.625, padding: '3.75px 9.375px', fontSize: 12.75, lineHeight: 1.4118, color: 'var(--foreground)' }}>
    <ChevronRight size={13.125} style={{ flexShrink: 0, color: muted, transform: expanded ? 'rotate(90deg)' : 'none' }} />
    {expanded ? <FolderOpen {...fileNode('var(--info)')} /> : <Folder {...fileNode('var(--info)')} />}
    <span style={{ marginLeft: depth * 11.25 }} />
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    {actions && <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3.75, fontSize: 11.25 }}>
      <button type="button" style={iconSm} title="打开"><FolderOpen size={13.125} /></button>
      <button type="button" style={iconSm} title={`在 访达 中显示`}><Monitor size={13.125} /></button>
    </span>}
  </div>
}

const iconSm = { display: 'inline-flex', padding: 2.625, border: 0, borderRadius: 4, background: 'transparent', color: muted, cursor: 'pointer' }
const iconSmHover = { ...iconSm, background: fg5, color: 'var(--foreground)' }

function FileTree() {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
    <FolderRow name="polaris-skill" depth={0} expanded icons />
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative' }}>
        <div aria-hidden="true" style={{ position: 'absolute', left: 13, top: 0, bottom: 0, width: 1, background: 'color-mix(in srgb, var(--border) 80%, transparent)' }} />
        <FileRow name="SKILL.md" depth={1} selected />
      </div>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div aria-hidden="true" style={{ position: 'absolute', left: 13, top: 0, bottom: 0, width: 1, background: 'color-mix(in srgb, var(--border) 80%, transparent)' }} />
        <FolderRow name="scripts" depth={1} expanded />
        <div aria-hidden="true" style={{ position: 'absolute', left: 23.5, top: 0, bottom: 0, width: 1, background: 'color-mix(in srgb, var(--border) 80%, transparent)' }} />
        <div style={{ marginLeft: 22.5 }}>
          <FileRow name="deploy.sh" depth={0} />
          <FileRow name="util.py" depth={0} />
        </div>
      </div>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div aria-hidden="true" style={{ position: 'absolute', left: 13, top: 0, bottom: 0, width: 1, background: 'color-mix(in srgb, var(--border) 80%, transparent)' }} />
        <FolderRow name="templates" depth={1} />
        <div aria-hidden="true" style={{ position: 'absolute', left: 23.5, top: 25, bottom: 0, width: 1, background: 'color-mix(in srgb, var(--border) 80%, transparent)' }} />
        <div style={{ marginLeft: 22.5 }}>
          <FileRow name="report.hbs" depth={0} />
        </div>
      </div>
    </div>
  </div>
}

// ---------------------------------------------------------------------------
// SessionInfoPopover — 360×460 floating popover frosted over the workbench.
// Right header action 在 Finder 中查看 is a static button (IPC unwired).
// ---------------------------------------------------------------------------

export function SourceSessionInfoPopover() {
  return <div data-route="session-info/popover" style={{ position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 30, background: 'var(--fg-2)', color: 'var(--foreground)', overflow: 'hidden' }}>
    <div style={{ width: 360, maxHeight: 460, overflowY: 'auto', boxSizing: 'border-box', border: '1px solid color-mix(in srgb, var(--border) 40%, transparent)', borderRadius: 16, background: 'var(--background)', boxShadow: 'var(--shadow-modal-small)', padding: '15px' }}>
      <div style={{ display: 'grid', gap: 15 }}>
        {/* Title */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5.625 }}>
          <span style={{ fontSize: 11.25, fontWeight: 500, color: muted, letterSpacing: '0.04em', textTransform: 'uppercase' }}>标题</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7.5 }}>
            <input readOnly value="无标题" aria-label="会话标题" style={{ flex: 1, height: 30, boxSizing: 'border-box', padding: '0 11.25px', borderRadius: 8, border: 0, background: 'var(--fg-2)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 12.75, outline: 'none' }} />
            <button type="button" aria-label="保存标题" style={{ display: 'inline-flex', width: 26.25, height: 26.25, alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 6, background: 'var(--accent)', color: 'var(--background)', cursor: 'pointer' }}><Check size={13.125} /></button>
          </div>
        </div>
        {/* Session files */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7.5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7.5 }}>
            <span style={{ fontSize: 12.75, fontWeight: 600 }}>会话文件</span>
            <button type="button" style={{ ...iconSmHover, fontSize: 11.25, gap: 3.75, padding: '3.75px 7.5px' }}>在 Finder 中查看</button>
          </div>
          <FileTree />
        </div>
      </div>
    </div>
  </div>
}

// ---------------------------------------------------------------------------
// FileViewer — right-side detail panel: mono header with the full path
// (selectable), then the scrubbed content block.
// ---------------------------------------------------------------------------

const skillMdFixture = `# polaris-skill

生成北极星(Polaris)周报的 Skill。支持按周聚合提交、生成 changelog 条目结构、提交时区修复等任务。

## 用法

\`\`\`bash
polo run polaris-skill
\`\`\`

> 说明:这是会话文件的只读预览。实际文件内容随工作区磁盘状态而定,此处为命名确定性 fixture。`

export function SourceFileViewer() {
  return <div data-route="session-info/viewer" style={{ width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: 'var(--background)', color: 'var(--foreground)', fontSize: 13.125 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '11.25px 15px', background: 'color-mix(in srgb, var(--muted) 50%, transparent)', borderBottom: '1px solid var(--border)' }}>
      <File size={15} style={{ color: muted, flexShrink: 0 }} />
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.975, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'all' }}>/workspaces/polaris/polaris-skill/SKILL.md</code>
    </div>
    <div style={{ flex: 1, overflowY: 'auto', padding: '22.5px', boxSizing: 'border-box' }}>
      <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11.975, lineHeight: 1.6, color: 'color-mix(in srgb, var(--foreground) 85%, transparent)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{skillMdFixture}</pre>
    </div>
  </div>
}

// ---------------------------------------------------------------------------
// FileViewer empty state — no file selected in the session.
// ---------------------------------------------------------------------------

export function SourceFileViewerEmpty() {
  return <div data-route="session-info/viewer-empty" style={{ width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7.5, padding: 30, background: 'var(--background)', color: 'var(--foreground)' }}>
    <div style={{ display: 'flex', width: 60, height: 60, alignItems: 'center', justifyContent: 'center', borderRadius: 15, background: 'var(--muted)' }}>
      <FileText size={30} style={{ color: muted }} />
    </div>
    <span style={{ fontSize: 13.125, fontWeight: 500 }}>未选择文件</span>
    <span style={{ fontSize: 11.25, color: muted }}>点击聊天中的文件路径在此查看</span>
  </div>
}