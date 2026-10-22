import { useState } from 'react'

// OrganizationAppCard.tsx + the HomePage.tsx 组织应用 section, as the
// enterprise-home fixture: one assigned organization with two app cards in
// their installed state. Card: min-h-[176px] rounded-xl border
// border-foreground/10 bg-[var(--background-elevated)] p-4 shadow-xs
// hover:shadow-minimal; AppArtwork size-12 rounded-xl (initial fallback is a
// sky-500→indigo-600 gradient with a white letter); description line-clamp-2
// min-h-9 text-xs/65%; footer status line text-[11px] + h-1 accent progress
// bar + action button. Organization display name is a named fixture.
export function SourceOrganizationAppsSection() {
  const apps = [
    { id: 'chart-kit', name: 'Chart Kit', description: '从会话数据生成可分享的图表面板。', status: '已安装', progress: 1 },
    { id: 'doc-sprint', name: 'Doc Sprint', description: '把会话结论整理成结构化文档草稿。', status: '已安装', progress: 1 },
  ]
  return <section aria-labelledby="organization-apps-heading">
    <div className="source-home__heading">
      <div>
        <h2 id="organization-apps-heading">Polo 工作室应用</h2>
        <p>此创作者空间发布的应用。</p>
      </div>
    </div>
    <div className="source-home__grid source-home__grid--cards">
      {apps.map(app => <OrganizationAppCard key={app.id} app={app} />)}
    </div>
  </section>
}

function OrganizationAppCard({ app }) {
  const [hovered, setHovered] = useState(false)
  return <article onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ display: 'flex', minHeight: 132, flexDirection: 'column', boxSizing: 'border-box', padding: 15, border: '1px solid color-mix(in srgb, var(--foreground) 10%, transparent)', borderRadius: 11.25, background: 'var(--background-elevated, var(--background))', boxShadow: hovered ? 'var(--shadow-minimal)' : '0 1px 2px 0 rgba(0,0,0,.05)', opacity: 1, transition: 'box-shadow 150ms' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 11.25 }}>
      <AppArtwork name={app.name} />
      <div style={{ minWidth: 0 }}>
        <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.125, fontWeight: 600 }}>{app.name}</h3>
      </div>
    </div>
    {/* line-clamp-2 with min-h-9 = 27px at the 15px root. */}
    <p style={{ margin: '7.5px 0 0', minHeight: 27, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', color: 'color-mix(in srgb, var(--foreground) 65%, transparent)', fontSize: 12, lineHeight: 1.35 }}>{app.description}</p>
    <div style={{ display: 'flex', flex: 1 }} />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 7.5, marginTop: 11.25 }}>
      <span style={{ color: 'color-mix(in srgb, var(--foreground) 60%, transparent)', fontSize: 11 }}>{app.status}</span>
      <button type="button" style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', padding: '0 11.25px', border: 0, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500, cursor: 'pointer' }}>打开</button>
    </div>
  </article>
}

// AppArtwork: size-12 (45px) rounded-xl; without an icon the initial renders
// on a sky→indigo gradient.
function AppArtwork({ name }) {
  return <span aria-hidden="true" style={{ display: 'grid', width: 45, height: 45, flexShrink: 0, placeItems: 'center', borderRadius: 11.25, background: 'linear-gradient(135deg, #0ea5e9, #4f46e5)', color: '#fff', fontSize: 18.75, fontWeight: 600 }}>{name.charAt(0)}</span>
}
