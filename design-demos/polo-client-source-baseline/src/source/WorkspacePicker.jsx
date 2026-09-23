import { useState } from 'react'
import { Cloud, FolderOpen, FolderPlus, Plus, X } from 'lucide-react'
import { SourceWorkspaceCreateNewStep, SourceWorkspaceOpenFolderStep, SourceWorkspaceConnectRemoteStep, SourceWorkspaceConnectRemoteCreateStep, SourceServerDirectoryBrowser } from './WorkspaceSteps.jsx'

// WorkspacePicker.tsx (loading / empty with a real zero-workspace dataset) and
// WorkspaceCreationScreen.tsx → AddWorkspaceStep_Choice.tsx (choice step),
// framed by primitives.tsx: AddWorkspaceContainer (max-w-[28rem] bg-background
// rounded-[20px] shadow-strong p-8 items-center) and AddWorkspaceStepHeader
// (text-lg font-semibold tracking-tight + mt-1 text-sm max-w-sm muted). The
// creation screen adds a 50px titlebar drag region with a p-2 rounded-[6px]
// shadow-minimal X close button (WorkspaceCreationScreen.tsx:180-211). Copy is
// zh-Hans from zh-Hans.json workspace.*. There are deliberately no fabricated
// remote workspaces: the list is IPC-owned runtime data, so the picker body
// renders the empty branch (list omitted, divider + create form remain).
const fg5 = 'color-mix(in srgb, var(--foreground) 5%, transparent)'
const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'
const muted = 'var(--fg-50)'
// button.tsx default: h-9 px-4 text-sm font-medium rounded-md.
const primaryButton = { display: 'inline-flex', width: '100%', height: 33.75, alignItems: 'center', justifyContent: 'center', gap: 7.5, border: 0, borderRadius: 5.625, color: 'var(--background)', background: 'var(--accent)', fontSize: 13.125, fontWeight: 500 }

export function SourceWorkspacePicker({ state }) {
  if (state === 'loading') return <CreationScreenFrame><PickerLoading /></CreationScreenFrame>
  // AddWorkspace flow: the creation steps translate
  // AddWorkspaceStep_{CreateNew,OpenFolder,ConnectRemote}.tsx forms with named
  // deterministic fixtures (see WorkspaceSteps.jsx). connect-remote-create is
  // the same component's "create new workspace on server" branch and
  // server-browser opens the ServerDirectoryBrowser dialog.
  if (state === 'create') return <CreationScreenFrame><SourceWorkspaceCreateNewStep /></CreationScreenFrame>
  if (state === 'open-folder') return <CreationScreenFrame><SourceWorkspaceOpenFolderStep /></CreationScreenFrame>
  if (state === 'connect-remote') return <CreationScreenFrame><SourceWorkspaceConnectRemoteStep /></CreationScreenFrame>
  if (state === 'connect-remote-create') return <CreationScreenFrame><SourceWorkspaceConnectRemoteCreateStep /></CreationScreenFrame>
  if (state === 'server-browser') return <SourceServerDirectoryBrowser />
  return <PickerEmpty />
}

// Picker mount: flex h-screen items-center justify-center bg-sidebar px-4.
function PickerShell({ children }) { return <div data-route="workspace-picker" style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 15, boxSizing: 'border-box', background: 'var(--fg-2)' }}><Container>{children}</Container></div> }
function Container({ children }) { return <section style={{ display: 'flex', width: '100%', maxWidth: 420, flexDirection: 'column', alignItems: 'center', boxSizing: 'border-box', padding: 30, borderRadius: 20, background: 'var(--background)', boxShadow: 'var(--shadow-strong)' }}>{children}</section> }
function Header({ title, description }) { return <div style={{ width: '100%', textAlign: 'center' }}><h1 style={{ margin: 0, color: 'var(--foreground)', fontSize: 16.875, fontWeight: 600, letterSpacing: '-.025em' }}>{title}</h1><p style={{ maxWidth: 360, margin: '3.75px auto 0', color: muted, fontSize: 13.125, lineHeight: 1.375 }}>{description}</p></div> }

function PickerLoading() {
  return <PickerShell>
    <CubeSpinner style={{ fontSize: 22.5 }} />
    <p style={{ margin: '11.25px 0 0', color: muted, fontSize: 13.125 }}>正在加载工作区...</p>
  </PickerShell>
}

function PickerEmpty() {
  const [name, setName] = useState('')
  return <PickerShell>
    <Header title="选择 Workspace" description="选择此服务器上的 Workspace 或创建新的。" />
    <div style={{ width: '100%', margin: '18.75px 0 15px', borderTop: `1px solid ${fg15}` }} />
    <div style={{ display: 'grid', width: '100%', gap: 7.5 }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="新 Workspace 名称" style={{ width: '100%', height: 33.75, boxSizing: 'border-box', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, outline: 0, color: 'var(--foreground)', background: 'transparent', fontSize: 13.125 }} />
      <button type="button" disabled={!name.trim()} style={{ ...primaryButton, opacity: name.trim() ? 1 : .5 }}><Plus size={15} style={{ marginRight: 5.625 }} />创建 Workspace</button>
    </div>
  </PickerShell>
}

// FullscreenOverlayBase (z-splash bg-background) + 50px titlebar header with a
// drag region and the p-2 rounded-[6px] shadow-minimal close button.
function CreationScreenFrame({ children }) {
  return <div data-route="workspace-creation/choice" style={{ position: 'relative', display: 'flex', width: '100%', height: '100%', minHeight: 0, flexDirection: 'column', background: 'var(--background)' }}>
    <header style={{ position: 'relative', height: 50, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 22.5px' }}>
      <button type="button" aria-label="Close" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 7.5, border: 0, borderRadius: 6, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: muted, marginRight: -8, marginTop: 7.5 }}><X size={15} /></button>
    </header>
    <main style={{ position: 'relative', display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>{children}</main>
  </div>
}

function CreationChoice() {
  return <Container>
    <div style={{ height: 7.5 }} />
    <Header title="添加 Workspace…" description="让创意与实现工具相遇的地方。" />
    {/* mt-8 space-y-3 → 30px top, 11.25px between cards. */}
    <div style={{ width: '100%', marginTop: 30, display: 'grid', gap: 11.25 }}>
      <Choice icon={FolderPlus} title="新建" description="从空白 Workspace 开始。" accent />
      <Choice icon={FolderOpen} title="打开文件夹" description="选择现有文件夹作为 Workspace。" />
      <Choice icon={Cloud} title="连接远程服务器" description="使用远程 Polo AI 服务器。" />
    </div>
  </Container>
}

// ChoiceCard: p-4 gap-4 rounded-lg bg-background shadow-minimal, 40px icon
// tile rounded-lg (primary accent/10 · accent, secondary fg/5 · fg/70),
// text-[15px] = exact 15px medium title, text-[12px] = exact 12px muted
// description at -mt-[1px] (arbitrary values are not rem-scaled).
function Choice({ icon: Icon, title, description, accent = false }) { return <button type="button" style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 15, padding: 15, border: 0, borderRadius: 7.5, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', textAlign: 'left' }}><span style={{ display: 'flex', width: 37.5, height: 37.5, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 7.5, color: accent ? 'var(--accent)' : 'color-mix(in srgb, var(--foreground) 70%, transparent)', background: accent ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : fg5 }}><Icon size={18.75} /></span><span style={{ minWidth: 0 }}><span style={{ display: 'block', fontSize: 15, fontWeight: 500 }}>{title}</span><small style={{ display: 'block', marginTop: -1, color: muted, fontSize: 12 }}>{description}</small></span></button> }

// SpinKit grid spinner (LoadingIndicator.tsx): keyframes live in base.css.
function CubeSpinner({ style }) {
  const cubeStyle = { backgroundColor: 'currentColor', animation: 'spinner-grid 1.3s infinite ease-in-out', transform: 'scale3d(0.5,0.5,1)' }
  const delays = [0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0, 0.1, 0.2]
  return <span role="status" aria-label="加载中" style={{ display: 'inline-grid', gridTemplateColumns: 'repeat(3, 1fr)', width: '1em', height: '1em', gap: '0.08em', color: 'var(--foreground)', ...style }}>{delays.map((delay, index) => <span key={index} style={{ ...cubeStyle, animationDelay: delay + 's' }}/>)}</span>
}
