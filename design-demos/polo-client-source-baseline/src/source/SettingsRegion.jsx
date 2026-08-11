import React, { useMemo, useState } from 'react'
import {
  Building2,
  Keyboard,
  MessageSquare,
  MoreHorizontal,
  Palette,
  Server,
  ShieldCheck,
  Tag,
  ToggleRight,
  UserCircle,
} from 'lucide-react'

// Source-faithful desktop settings/app route. Colours intentionally use the
// Renderer semantic tokens already present in the prototype token sheet.
const color = {
  surface: 'var(--background)',
  raised: 'var(--background-elevated, var(--background))',
  foreground: 'var(--foreground)',
  muted: 'var(--muted-foreground)',
  border: 'color-mix(in srgb, var(--border) 50%, transparent)',
  selected: 'color-mix(in srgb, var(--foreground) 5%, transparent)',
  hover: 'color-mix(in srgb, var(--foreground) 2%, transparent)',
  shadow: 'var(--shadow-minimal, 0 1px 2px rgba(0,0,0,.05))',
}

// Exact order, icon map, and i18n-resolved English copy from the shared
// settings registry. Account Security and Server remain feature-gated exactly
// as getVisibleSettingsItems() does in the real Renderer.
const settingsItems = [
  { id: 'app', label: 'App', description: 'Notifications and updates', Icon: ToggleRight },
  { id: 'account-security', label: 'Account Security', description: 'Password and account protection', Icon: ShieldCheck, requiresAdminLogin: true },
  { id: 'appearance', label: 'Appearance', description: 'Theme, font, tool icons', Icon: Palette },
  { id: 'input', label: 'Input', description: 'Send key, spell check', Icon: Keyboard },
  { id: 'workspace', label: 'Workspace', description: 'Name, icon, working directory', Icon: Building2 },
  { id: 'permissions', label: 'Permissions', description: 'Explore mode rules', Icon: ShieldCheck },
  { id: 'labels', label: 'Labels', description: 'Manage session labels', Icon: Tag },
  { id: 'messaging', label: 'Messaging', description: 'Connect Telegram, WhatsApp, Lark', Icon: MessageSquare },
  { id: 'server', label: 'Server', description: 'Remote server access', Icon: Server, requiresEmbeddedServer: true },
  { id: 'shortcuts', label: 'Shortcuts', description: 'Keyboard shortcuts', Icon: Keyboard },
  { id: 'preferences', label: 'Preferences', description: 'User preferences', Icon: UserCircle },
]

function SettingsCard({ children }) {
  return <div style={{ overflow: 'hidden', borderRadius: 12, background: color.surface, boxShadow: color.shadow }}>{children}</div>
}

function SettingsDivider() {
  return <div aria-hidden="true" style={{ height: 1, marginLeft: 16, marginRight: 16, background: color.border }} />
}

function SettingsSection({ title, children }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ paddingLeft: 4 }}>
        <h3 style={{ margin: 0, color: color.foreground, fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>{title}</h3>
      </div>
      {children}
    </section>
  )
}

function SettingsToggle({ label, description, checked, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 16px' }}>
      <label style={{ flex: 1, minWidth: 0, cursor: 'pointer', userSelect: 'none' }}>
        <div style={{ color: color.foreground, fontSize: 14, fontWeight: 500, lineHeight: 1.5 }}>{label}</div>
        <div style={{ color: color.muted, fontSize: 14, lineHeight: 1.5 }}>{description}</div>
      </label>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{ position: 'relative', flexShrink: 0, width: 36, height: 20, padding: 0, border: 0, borderRadius: 9999, cursor: 'pointer', background: checked ? color.foreground : 'color-mix(in srgb, var(--foreground) 18%, transparent)', transition: 'background-color 150ms ease' }}
      >
        <span style={{ position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: 9999, background: color.surface, boxShadow: '0 1px 2px rgba(0,0,0,.16)', transition: 'left 150ms ease' }} />
      </button>
    </div>
  )
}

function SettingsRow({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, gap: 16, padding: '14px 16px' }}>
      <div style={{ flex: 1, minWidth: 0, color: color.foreground, fontSize: 14, fontWeight: 500, lineHeight: 1.5 }}>{label}</div>
      <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 12 }}>{children}</div>
    </div>
  )
}

function HeaderMenuButton() {
  // HeaderMenu.tsx uses HeaderIconButton + the actual MoreHorizontal icon.
  return (
    <button
      type="button"
      aria-label="More options"
      style={{ display: 'inline-flex', width: 28, height: 28, padding: 0, alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 6, background: 'transparent', color: color.muted }}
    >
      <MoreHorizontal size={16} strokeWidth={2} />
    </button>
  )
}

function PanelHeader({ title }) {
  return (
    <div style={{ display: 'flex', position: 'relative', zIndex: 1, flexShrink: 0, alignItems: 'center', minWidth: 0, height: 42, gap: 6, paddingLeft: 16, paddingRight: 8 }}>
      <div style={{ display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', userSelect: 'none' }}>
        <div style={{ maxWidth: '100%', overflow: 'hidden', margin: '0 auto' }}>
          <h1 style={{ overflow: 'hidden', margin: 0, color: color.foreground, fontSize: 14, fontWeight: 600, lineHeight: 1.25, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h1>
        </div>
      </div>
      <HeaderMenuButton />
    </div>
  )
}

function SettingsNavigatorRow({ item, selected, onSelect }) {
  const [hovered, setHovered] = useState(false)
  const Icon = item.Icon

  return (
    <div style={{ position: 'relative', marginRight: 8, paddingLeft: 8 }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div style={{ pointerEvents: 'none', position: 'absolute', zIndex: 1, top: 14, left: 20, color: selected ? color.foreground : color.muted }}>
        <Icon size={16} strokeWidth={2} />
      </div>
      <button
        type="button"
        onClick={onSelect}
        style={{ display: 'flex', width: '100%', alignItems: 'flex-start', gap: 8, padding: '12px 16px 12px 8px', border: 0, borderRadius: 8, outline: 'none', background: selected ? color.selected : hovered ? color.hover : 'transparent', color: color.foreground, cursor: 'pointer', textAlign: 'left', transition: 'background-color 75ms ease' }}
      >
        {/* Source uses a w-6 h-5 spacer before the text for the absolute icon. */}
        <div style={{ flexShrink: 0, width: 24, height: 20 }} />
        <div style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column' }}>
          <span style={{ color: selected ? color.foreground : 'color-mix(in srgb, var(--foreground) 80%, transparent)', fontSize: 14, fontWeight: 500, lineHeight: 1.5 }}>{item.label}</span>
          <span style={{ overflow: 'hidden', color: 'color-mix(in srgb, var(--foreground) 60%, transparent)', fontSize: 12, lineHeight: 1.5, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.description}</span>
        </div>
      </button>
      {/* The real button is opacity-0 until the row is hovered or its menu opens. */}
      <button type="button" aria-label="Open in New Window" title="Open in New Window" style={{ position: 'absolute', zIndex: 2, top: 8, right: 8, display: 'flex', width: 28, height: 28, padding: 6, alignItems: 'center', justifyContent: 'center', border: '1px solid transparent', borderRadius: 8, opacity: hovered ? 1 : 0, background: 'transparent', color: color.muted, cursor: 'pointer', transition: 'opacity 150ms ease' }}>
        <MoreHorizontal size={16} strokeWidth={2} />
      </button>
    </div>
  )
}

function SettingsProxyInput({ label, placeholder }) {
  const [value, setValue] = useState('')
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 16px' }}>
      <label style={{ flex: 1, minWidth: 0, color: color.foreground, fontSize: 14, fontWeight: 500, lineHeight: 1.5 }}>{label}</label>
      <div style={{ flexShrink: 0, overflow: 'hidden', width: 200, borderRadius: 6, background: 'color-mix(in srgb, var(--muted-foreground) 10%, transparent)', boxShadow: color.shadow }}>
        <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} style={{ boxSizing: 'border-box', width: '100%', height: 32, padding: '0 12px', border: 0, outline: 0, background: 'transparent', color: color.foreground, fontSize: 14 }} />
      </div>
    </div>
  )
}

function AppSettingsPage({ isElectron, version }) {
  // These are the same useState defaults as AppSettingsPage.tsx before IPC
  // values resolve: notifications=true, keep-awake=false, browser=true,
  // empty disabled proxy form, and update version still loading.
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false)
  const [browserToolEnabled, setBrowserToolEnabled] = useState(true)
  const [proxyEnabled, setProxyEnabled] = useState(false)

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, flexDirection: 'column' }}>
      <PanelHeader title="App" />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ maxWidth: 768, margin: '0 auto', padding: '28px 20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
            <SettingsSection title="Notifications"><SettingsCard><SettingsToggle label="Desktop notifications" description="Get notified when AI finishes working in a chat." checked={notificationsEnabled} onChange={setNotificationsEnabled} /></SettingsCard></SettingsSection>
            <SettingsSection title="Power"><SettingsCard><SettingsToggle label="Keep screen awake" description="Prevent the screen from turning off while sessions are running." checked={keepAwakeEnabled} onChange={setKeepAwakeEnabled} /></SettingsCard></SettingsSection>
            <SettingsSection title="Tools"><SettingsCard><SettingsToggle label="Built-in browser" description="Disable if you use external browser tools like Playwright, Puppeteer, or browser MCP servers." checked={browserToolEnabled} onChange={setBrowserToolEnabled} /></SettingsCard></SettingsSection>
            <SettingsSection title="Network">
              <SettingsCard>
                <SettingsToggle label="HTTP proxy" description="Route network traffic through a proxy server." checked={proxyEnabled} onChange={setProxyEnabled} />
                {proxyEnabled && <><SettingsDivider /><SettingsProxyInput label="HTTP Proxy" placeholder="http://proxy.example.com:8080" /><SettingsDivider /><SettingsProxyInput label="HTTPS Proxy" placeholder="http://proxy.example.com:8080" /><SettingsDivider /><SettingsProxyInput label="Bypass Rules" placeholder="localhost, 127.0.0.1, .example.com" /></>}
              </SettingsCard>
            </SettingsSection>
            <SettingsSection title="About">
              <SettingsCard>
                <SettingsRow label="Version"><span style={{ color: color.muted, fontSize: 14, lineHeight: 1.5 }}>{version ?? 'Loading…'}</span></SettingsRow>
                {isElectron && <><SettingsDivider /><SettingsRow label="Check for updates"><button type="button" style={{ minHeight: 32, padding: '6px 12px', border: `1px solid ${color.border}`, borderRadius: 6, background: 'transparent', color: color.foreground, fontSize: 14, fontWeight: 500, lineHeight: 1.25, cursor: 'pointer' }}>Check Now</button></SettingsRow></>}
              </SettingsCard>
            </SettingsSection>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The Settings route region used by the desktop shell.  It deliberately only
 * mounts AppSettingsPage: other Settings pages must be supplied by their own
 * source translations instead of showing an invented intermediary state.
 */
export function SettingsRegion({
  isAdminLoggedIn = false,
  embeddedServer = false,
  isElectron = true,
  version = null,
  selectedSubpage = 'app',
  onSelectSubpage = () => {},
}) {
  const visibleItems = useMemo(() => settingsItems.filter((item) => (!item.requiresAdminLogin || isAdminLoggedIn) && (!item.requiresEmbeddedServer || embeddedServer)), [embeddedServer, isAdminLoggedIn])

  return (
    <div className="source-settings-region" data-route="settings/app" style={{ display: 'flex', flex: '1 1 0', minWidth: 0, height: '100%', minHeight: 0, gap: 6, color: color.foreground, background: 'var(--app-bg, transparent)', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}>
      <aside style={{ display: 'flex', width: 280, minWidth: 220, height: '100%', flexDirection: 'column', overflow: 'hidden', borderRadius: 10, background: 'var(--foreground-2, var(--background-elevated, var(--background)))', boxShadow: 'var(--shadow-middle, 0 2px 5px rgba(0,0,0,.08))' }}>
        <div style={{ flex: 1, overflowY: 'auto', paddingTop: 8 }}>
          {visibleItems.map((item, index) => <React.Fragment key={item.id}>
            {index > 0 && <div aria-hidden="true" style={{ height: 1, marginLeft: 48, marginRight: 16, background: color.border }} />}
            <SettingsNavigatorRow item={item} selected={item.id === selectedSubpage} onSelect={() => onSelectSubpage(item.id)} />
          </React.Fragment>)}
        </div>
      </aside>
      <main style={{ display: 'flex', minWidth: 440, flex: 1, height: '100%', overflow: 'hidden', borderRadius: 10, background: 'var(--foreground-2, var(--background-elevated, var(--background)))', boxShadow: 'var(--shadow-middle, 0 2px 5px rgba(0,0,0,.08))' }}>
        <AppSettingsPage isElectron={isElectron} version={version} />
      </main>
    </div>
  )
}
