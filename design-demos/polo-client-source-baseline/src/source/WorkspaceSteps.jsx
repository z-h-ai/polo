import { ArrowLeft, CheckCircle, ChevronDown, ChevronRight, Folder, FolderSymlink, Plus, X, XCircle } from 'lucide-react'

// Static zh-Hans / source-literal translation of the Add Workspace creation
// steps (workspace/AddWorkspaceStep_{CreateNew,OpenFolder,ConnectRemote}.tsx,
// AddWorkspace_RadioOption.tsx, primitives.tsx) and the server directory
// browser (ServerDirectoryBrowser.tsx), framed by WorkspaceCreationScreen.tsx.
//
// All IPC-owned values are named deterministic fixtures:
//   - homeDir                /Users/wow            (window.electronAPI.getHomeDir)
//   - customPath             /Users/wow/projects   (directory picker result)
//   - checkWorkspaceSlug     exists:false → no validation error
//   - testRemoteConnection   ok:true, serverVersion "0.11.2" → Connected
//   - remoteWorkspaces       [{ws-1, 开发环境}, {ws-2, RRF 复盘}], selected ws-1
//   - server listing         /Users/wow with 6 entries, truncated 6/42,
//                            one symlink (shared-notes)
// Hardcoded English strings in the source (ConnectRemote headers, Test
// Connection / Connected / Go / Cancel / Select) stay literal; t()-keyed
// strings use zh-Hans.json. SelectContent is a Radix portal dropdown that is
// not part of the static snapshot, so the trigger renders at its collapsed
// current value. token.js "default" Button variant is bg-foreground/
// text-background (button.tsx: bg-foreground text-background), unlike the
// accent-primary used by older sub-views of other components.
const fg5 = 'color-mix(in srgb, var(--foreground) 5%, transparent)'
const fg10 = 'color-mix(in srgb, var(--foreground) 10%, transparent)'
const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'
const fg30 = 'color-mix(in srgb, var(--foreground) 30%, transparent)'
const muted = 'var(--fg-50)'
const muted60 = 'color-mix(in srgb, var(--muted-foreground) 60%, transparent)'
// text-green-600 (#16a34a; dark:green-400 would be #4ade80) and the yellow
// warning (bg-yellow-500/10 border-yellow-500/20 text-yellow-700, dark
// variants #facc15) are tailwind literal colors with no token equivalent.
const okGreen = '#16a34a'
const warnYellow = '#a16207'
const warnBg = 'color-mix(in srgb, #eab308 10%, transparent)'
const warnBorder = 'color-mix(in srgb, #eab308 20%, transparent)'
// AddWorkspaceContainer: flex w-full max-w-[28rem] flex-col items-center
// bg-background rounded-[20px] shadow-strong p-8.
const container = { display: 'flex', width: '100%', maxWidth: 420, flexDirection: 'column', alignItems: 'center', boxSizing: 'border-box', padding: 30, borderRadius: 20, background: 'var(--background)', boxShadow: 'var(--shadow-strong)' }
// AddWorkspaceStepHeader: text-center; h-1 text-lg font-semibold tracking-tight
// + mt-1 text-sm max-w-sm text-muted-foreground mx-auto.
function StepHeader({ title, description }) { return <div style={{ width: '100%', textAlign: 'center' }}><h1 style={{ margin: 0, color: 'var(--foreground)', fontSize: 18.75, fontWeight: 600, letterSpacing: '-.025em' }}>{title}</h1>{description && <p style={{ maxWidth: 480, margin: '3.75px auto 0', color: muted, fontSize: 13.125, lineHeight: 1.375 }}>{description}</p>}</div> }

// Back: self-start flex items-center gap-1 text-sm text-muted-foreground mb-4.
const backButton = { display: 'flex', alignItems: 'center', gap: 3.75, alignSelf: 'flex-start', marginBottom: 15, padding: 0, border: 0, background: 'none', color: muted, fontSize: 13.125, cursor: 'pointer' }
// Button default: h-9 px-4 text-sm font-medium rounded-md (bg-foreground
// text-background). disabled:opacity-50.
const primaryButton = { display: 'inline-flex', width: '100%', height: 33.75, alignItems: 'center', justifyContent: 'center', gap: 7.5, border: 0, borderRadius: 5.625, color: 'var(--background)', background: 'var(--foreground)', fontSize: 13.125, fontWeight: 500, cursor: 'pointer' }
// AddWorkspaceSecondaryButton: variant secondary size sm with className
// bg-background shadow-minimal → h-8 px-3 text-xs rounded-md.
const secondaryButton = { display: 'inline-flex', height: 30, alignItems: 'center', gap: 7.5, padding: '0 11.25px', border: 0, borderRadius: 5.625, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500, flexShrink: 0, cursor: 'pointer' }
// Input (input.tsx) with the step overrides border-0 bg-transparent shadow-none:
// flex h-9 w-full px-3 text-sm rounded-md → wrapped in bg-background
// shadow-minimal rounded-lg by each step.
const inputField = { width: '100%', height: 33.75, boxSizing: 'border-box', padding: '0 11.25px', border: 0, borderRadius: 5.625, outline: 0, color: 'var(--foreground)', background: 'transparent', fontSize: 13.125 }
const inputWrap = { background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', borderRadius: 7.5 }
const fieldLabel = { display: 'block', marginBottom: 9.375, color: 'var(--foreground)', fontSize: 13.125, fontWeight: 500 }
// text-xs text-muted-foreground link rows (Plus / ArrowLeft h-3 w-3).
const linkRow = { display: 'flex', alignItems: 'center', gap: 3.75, padding: 0, border: 0, background: 'none', color: muted, fontSize: 11.25, cursor: 'pointer' }

// AddWorkspace_RadioOption: label flex items-center gap-3 p-3 rounded-lg
// bg-background shadow-minimal; circular radio h-4 w-4 border-2 (checked
// border-accent + inner dot h-2 w-2 bg-accent, else border-foreground/30);
// title text-sm font-medium; subtitle text-xs muted truncate.
function RadioOption({ checked, title, subtitle, action }) {
  return <div role="radio" aria-checked={checked} style={{ display: 'flex', alignItems: 'center', gap: 11.25, padding: 11.25, borderRadius: 7.5, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)' }}>
    <span style={{ display: 'flex', width: 16, height: 16, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: `2px solid ${checked ? 'var(--accent)' : fg30}` }}>{checked && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />}</span>
    <span style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13.125, fontWeight: 500 }}>{title}</div>
      <div style={{ marginTop: -1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: muted, fontSize: 11.25 }}>{subtitle}</div>
    </span>
    {action}
  </div>
}

export function SourceWorkspaceCreateNewStep() {
  // Fixture: name "polo-app" (slug free), custom location already picked as
  // /Users/wow/projects → finalPath ~/projects/polo-app, canCreate true.
  return <section data-route="workspace-creation/create" style={container}>
    <button type="button" style={backButton}><ArrowLeft size={16} />返回</button>
    <StepHeader title="创建 Workspace" description="输入名称并选择 Workspace 存储位置。" />
    <div style={{ display: 'grid', width: '100%', gap: 22.5, marginTop: 22.5 }}>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label style={fieldLabel}>工作区名称</label>
        <div style={inputWrap}><input value="polo-app" readOnly placeholder="我的 Workspace" style={inputField} /></div>
        {/* Error p is absent: the slug check exists:false by fixture. */}
      </div>
      <div style={{ display: 'grid', gap: 11.25 }}>
        <label style={fieldLabel}>位置</label>
        <RadioOption checked={false} title="默认位置" subtitle=".polo-ai 文件夹下" />
        <RadioOption checked title="选择位置" subtitle="/Users/wow/projects" action={<button type="button" style={secondaryButton}>浏览</button>} />
      </div>
      <button type="button" style={primaryButton}>创建</button>
    </div>
  </section>
}

export function SourceWorkspaceOpenFolderStep() {
  // Fixture: selectedPath /Users/wow/projects/polaris-app (folder already
  // browsed); name derives from the folder basename → canOpen true.
  return <section data-route="workspace-creation/open-folder" style={container}>
    <button type="button" style={backButton}><ArrowLeft size={16} />返回</button>
    <StepHeader title="选择现有文件夹" description="选择任意文件夹作为 Workspace。" />
    <div style={{ display: 'grid', width: '100%', gap: 22.5, marginTop: 22.5 }}>
      {/* Browse row: flex items-center justify-between gap-4 p-4 rounded-xl
          border border-border/50 bg-background. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 15, padding: 15, borderRadius: 10, border: '1px solid color-mix(in srgb, var(--border) 50%, transparent)', background: 'var(--background)' }}>
        <div style={{ flex: 1, minWidth: 0 }}><p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.125 }}>/Users/wow/projects/polaris-app</p></div>
        <button type="button" style={secondaryButton}>浏览</button>
      </div>
      {/* Name input only after a folder is selected. */}
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label style={fieldLabel}>工作区名称</label>
        <div style={inputWrap}><input value="polaris-app" readOnly placeholder="我的 Workspace" style={inputField} /></div>
      </div>
      <button type="button" style={primaryButton}>打开</button>
    </div>
  </section>
}

// AddWorkspaceStep_ConnectRemote — existing-workspace branch. Headers, labels,
// Test Connection and the Connect button are hardcoded English in the source
// and are kept literal; only t()-keyed strings are zh-Hans.
function ConnectRemoteFrame({ createMode }) {
  return <div data-route={`workspace-creation/${createMode ? 'connect-remote-create' : 'connect-remote'}`} style={container}>
    <button type="button" style={backButton}><ArrowLeft size={16} />Back</button>
    <StepHeader title="Connect to remote server" description="Connect to a remote Polo AI Server for this workspace." />
    <div style={{ display: 'grid', width: '100%', gap: 18.75, marginTop: 22.5 }}>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label style={fieldLabel}>Server URL</label>
        <div style={inputWrap}><input value="ws://192.168.1.100:9100" readOnly style={{ ...inputField, fontFamily: 'var(--font-mono)', fontSize: 13.125 }} /></div>
      </div>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label style={fieldLabel}>Token</label>
        <div style={inputWrap}><input type="password" value="demo-server-token" readOnly placeholder="服务器认证令牌" style={inputField} /></div>
      </div>
      {/* Test Connection row: flex items-center gap-3; fixture testState=ok,
          serverVersion 0.11.2 → Connected — v0.11.2 (text-green-600). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11.25 }}>
        <button type="button" style={secondaryButton}>Test Connection</button>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3.75, color: okGreen, fontSize: 11.25 }}><CheckCircle size={13.125} />Connected — v0.11.2</span>
      </div>
      {/* Old-server warning is absent: serverVersion is present by fixture. */}
      {createMode ? (
        <div style={{ display: 'grid', gap: 7.5 }}>
          <label style={fieldLabel}>Workspace name</label>
          <div style={inputWrap}><input value="我的远程 Workspace" readOnly placeholder="我的远程 Workspace" style={inputField} /></div>
          <p style={{ margin: 0, color: muted, fontSize: 11.25 }}>A workspace will be created on the remote server with this name.</p>
          <button type="button" style={linkRow}><ArrowLeft size={12} />Use existing workspace</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 7.5 }}>
          <label style={fieldLabel}>Workspace</label>
          {/* Select collapsed at the fixture value; SelectContent is a Radix
              portal dropdown outside the static snapshot. */}
          <div style={{ ...inputWrap, display: 'flex', alignItems: 'center' }}>
            <button type="button" aria-haspopup="listbox" style={{ display: 'flex', width: '100%', height: 33.75, alignItems: 'center', justifyContent: 'space-between', gap: 7.5, padding: '0 11.25px', border: 0, borderRadius: 5.625, background: 'transparent', color: 'var(--foreground)', fontSize: 13.125, whiteSpace: 'nowrap', cursor: 'pointer' }}>开发环境<ChevronDown size={16} style={{ opacity: 0.5, flexShrink: 0 }} /></button>
          </div>
          <button type="button" style={linkRow}><Plus size={12} />Create new workspace on server</button>
        </div>
      )}
      <button type="button" style={primaryButton}>{createMode ? 'Create and Connect' : 'Connect'}</button>
    </div>
  </div>
}

export function SourceWorkspaceConnectRemoteStep() { return <ConnectRemoteFrame createMode={false} /> }

export function SourceWorkspaceConnectRemoteCreateStep() { return <ConnectRemoteFrame createMode /> }

// ServerDirectoryBrowser.tsx — browse-mode dialog, open with a loaded listing
// fixture (currentPath /Users/wow, 6 entries of 42, one symlink). Dialog
// skeleton per dialog.tsx DialogContent max-w-lg: fixed center, popover-styled
// (radius 8, background, foreground), p-6 gap-4, title text-lg font-semibold,
// X close top-4 right-4 rounded-xs opacity-70. Footer Cancel (outline) /
// Select (default).
export function SourceServerDirectoryBrowser() {
  const crumbs = [
    { path: '/', name: '/' }, { path: '/Users', name: 'Users' }, { path: '/Users/wow', name: 'wow' } ]
  const entries = [
    { path: '/Users/wow/projects', name: 'projects', isSymlink: false },
    { path: '/Users/wow/code', name: 'code', isSymlink: false },
    { path: '/Users/wow/documents', name: 'documents', isSymlink: false },
    { path: '/Users/wow/shared-notes', name: 'shared-notes', isSymlink: true },
    { path: '/Users/wow/notebooks', name: 'notebooks', isSymlink: false },
    { path: '/Users/wow/source', name: 'source', isSymlink: false },
  ]
  return <div data-route="server-directory-browser" style={{ position: 'relative', display: 'grid', width: '100%', height: '100%', minHeight: 0, placeItems: 'center', background: 'rgba(0,0,0,.5)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="sdb-title" style={{ position: 'relative', display: 'grid', width: 'min(512px, calc(100% - 32px))', gap: 15, boxSizing: 'border-box', padding: 22.5, borderRadius: 8, background: 'var(--background)', color: 'var(--foreground)', boxShadow: 'var(--shadow-modal-small)' }}>
      {/* Close — dialog.tsx dialog-close: top-4 right-4 rounded-xs opacity-70. */}
      <button type="button" aria-label="Close" style={{ position: 'absolute', top: 15, right: 15, display: 'flex', padding: 0, border: 0, borderRadius: 2, background: 'none', color: 'inherit', opacity: 0.7, cursor: 'pointer' }}><X size={16} /></button>
      <h2 id="sdb-title" style={{ margin: 0, fontSize: 18.75, lineHeight: 1, fontWeight: 600 }}>选择服务器目录</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7.5 }}>
        {/* Path input + Go (outline sm). */}
        <div style={{ display: 'flex', gap: 7.5 }}>
          <input value="/Users/wow" readOnly placeholder="输入路径..." style={{ ...inputField, flex: 1, minWidth: 0, border: `1px solid ${fg15}` }} />
          <button type="button" style={{ ...secondaryButton, height: 30, border: `1px solid ${fg15}`, borderRadius: 5.625 }}>Go</button>
        </div>
        {/* Breadcrumbs: text-xs muted, chevron size-3 between. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 1.875, minHeight: 24, paddingTop: 3.75, paddingBottom: 3.75, overflowX: 'auto', color: muted, fontSize: 11.25 }}>
          {crumbs.map((crumb, index) => <span key={crumb.path} style={{ display: 'flex', alignItems: 'center', gap: 1.875, flexShrink: 0 }}>{index > 0 && <ChevronRight size={12} style={{ color: 'color-mix(in srgb, var(--muted-foreground) 50%, transparent)' }} />}<span style={{ padding: '0 1.875px' }}>{crumb.name}</span></span>)}
        </div>
        {/* Listing: border border-foreground/10 rounded-md, max-h-[300px]. */}
        <div style={{ border: `1px solid ${fg10}`, borderRadius: 5.625, overflow: 'hidden' }}>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <div style={{ borderBottom: `1px solid ${fg10}`, padding: '7.5px 11.25px', color: muted, fontSize: 11.25 }}>Showing the first {entries.length} folders out of 42. Narrow the path if the folder you want is missing.</div>
            {entries.map(entry => <button key={entry.path} type="button" style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 7.5, padding: '5.625px 11.25px', border: 0, background: 'none', color: 'var(--foreground)', fontSize: 13.125, textAlign: 'left', cursor: 'pointer' }}>{entry.isSymlink ? <FolderSymlink size={16} style={{ flexShrink: 0, color: muted }} /> : <Folder size={16} style={{ flexShrink: 0, color: muted }} />}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>{entry.isSymlink && <span style={{ flexShrink: 0, color: muted60, fontSize: 11.25 }}>symlink</span>}</button>)}
          </div>
        </div>
      </div>
      {/* Footer: justify-end gap-2. Cancel = outline h-9 px-4; Select = default. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7.5 }}>
        <button type="button" style={{ display: 'inline-flex', height: 33.75, alignItems: 'center', gap: 7.5, padding: '0 15px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 13.125, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
        <button type="button" style={{ ...primaryButton, width: 'auto', padding: '0 15px' }}>Select</button>
      </div>
    </section>
  </div>
}