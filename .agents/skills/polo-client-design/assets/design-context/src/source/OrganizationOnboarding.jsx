import { useState } from 'react'
import { Building2, Check, Sparkles, Users } from 'lucide-react'

// Fixed visible states from OrganizationOnboarding.tsx. Organization summaries
// and join previews come solely from IPC, so no member/org identities are made
// up: loading renders the spinner column, join/select render their card
// frames with the IPC-preview slot (spinner body here), and create renders the
// full form. Copy is zh-Hans from zh-Hans.json organization.*. Root font-size
// is 15px: rounded-2xl=15px, p-6=22.5px, max-w-xl=540px, size-12=45px,
// text-xl=18.75px, h-11=41.25px.
const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'
const border60 = 'color-mix(in srgb, var(--border) 60%, transparent)'
const border70 = 'color-mix(in srgb, var(--border) 70%, transparent)'
const muted = 'var(--fg-50)'

export function SourceOrganizationOnboarding({ state }) {
  if (state === 'loading' || state === 'idle') return <Frame><OrganizationLoading /></Frame>
  if (state === 'join') return <Frame><CardFrame><OrganizationCardHeader title="组织邀请" /><div style={{ marginTop: 22.5, display: 'flex', justifyContent: 'center', padding: '30px 0' }}><CubeSpinner style={{ fontSize: 15 }} /></div></CardFrame></Frame>
  if (state === 'select') return <Frame><CardFrame><div style={{ width: '100%', textAlign: 'center' }}><h1 style={{ margin: 0, fontSize: 18.75, fontWeight: 600 }}>选择组织</h1><p style={{ margin: '7.5px 0 0', color: muted, fontSize: 13.125 }}>选择此窗口当前使用的组织上下文。</p></div><div style={{ marginTop: 22.5, display: 'flex', justifyContent: 'center', padding: '30px 0' }}><CubeSpinner style={{ fontSize: 15 }} /></div></CardFrame></Frame>
  return <Frame><OrganizationCreate /></Frame>
}
function Frame({ children }) { return <main data-route="organization/onboarding" style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, alignItems: 'center', justifyContent: 'center', overflow: 'auto', boxSizing: 'border-box', padding: 22.5, color: 'var(--foreground)', background: 'var(--background)' }}><div style={{ width: '100%', maxWidth: 540 }}>{children}</div></main> }
// rounded-2xl border-border/60 bg-background p-6 shadow-minimal.
function CardFrame({ children }) { return <section style={{ padding: 22.5, border: `1px solid ${border60}`, borderRadius: 15, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)' }}>{children}</section> }
function OrganizationCardHeader({ title }) { return <div style={{ width: '100%', textAlign: 'center' }}><span style={{ display: 'flex', width: 45, height: 45, alignItems: 'center', justifyContent: 'center', margin: '0 auto', borderRadius: 11.25, color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}><Users size={22.5} /></span><h1 style={{ margin: '15px 0 0', fontSize: 18.75, fontWeight: 600 }}>{title}</h1></div> }

function OrganizationLoading() {
  return <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 11.25, padding: '60px 0' }}>
    <CubeSpinner style={{ fontSize: 15 }} />
    <p style={{ margin: 0, color: muted, fontSize: 13.125 }}>正在加载组织…</p>
  </div>
}

function OrganizationCreate() {
  const [type, setType] = useState('creator_space')
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const disabled = submitting || !name.trim() || !purpose.trim()
  return <CardFrame>
    <div style={{ width: '100%', textAlign: 'center' }}>
      <span style={{ display: 'flex', width: 45, height: 45, alignItems: 'center', justifyContent: 'center', margin: '0 auto', borderRadius: 11.25, color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}><Users size={22.5} /></span>
      <h1 style={{ margin: '15px 0 0', fontSize: 18.75, fontWeight: 600 }}>创建你的组织</h1>
      <p style={{ margin: '7.5px 0 0', color: muted, fontSize: 13.125 }}>创建企业工作区或创作者空间后继续。</p>
    </div>
    {/* mt-6 space-y-5 = 22.5px top, 18.75px between groups. */}
    <form onSubmit={event => event.preventDefault()} style={{ display: 'grid', gap: 18.75, marginTop: 22.5 }}>
      <fieldset disabled={submitting} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 11.25, border: 0, padding: 0, margin: 0 }}>
        <legend className="sr-only">组织类型</legend>
        <TypeCard selected={type === 'creator_space'} disabled={submitting} icon={Sparkles} title="创作者空间" description="发布 App，并发展成员社群。" onClick={() => setType('creator_space')} />
        <TypeCard selected={type === 'enterprise_workspace'} disabled={submitting} icon={Building2} title="企业工作区" description="面向企业内部的受控工作空间。" onClick={() => setType('enterprise_workspace')} />
      </fieldset>
      {/* space-y-2 label groups with ui/Label (14px medium) + ui/Input
          (h-9 border-foreground/15 rounded-md text-sm). */}
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label htmlFor="organization-name" style={{ fontSize: 13.125, fontWeight: 500, lineHeight: 1 }}>组织名称</label>
        <input id="organization-name" value={name} maxLength={128} disabled={submitting} placeholder="例如：Acme 工作室" onChange={e => setName(e.target.value)} style={inputStyle} />
      </div>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label htmlFor="organization-purpose" style={{ fontSize: 13.125, fontWeight: 500, lineHeight: 1 }}>这个空间将用于什么？</label>
        <textarea id="organization-purpose" value={purpose} maxLength={512} disabled={submitting} placeholder="描述团队或社群将在这里开展的工作" onChange={e => setPurpose(e.target.value)} style={{ ...inputStyle, height: 'auto', minHeight: 90, padding: '11.25px 11.25px 11.25px 11.25px', paddingTop: 7.5, paddingBottom: 7.5, resize: 'none' }} />
      </div>
      {/* button default h-9 → the page overrides to h-11 (41.25px); the
          submitting Spinner inherits the button's text-sm (13.125px → 1em). */}
      <button data-testid="organization-create-submit" type="submit" disabled={disabled} style={{ display: 'inline-flex', height: 41.25, width: '100%', alignItems: 'center', justifyContent: 'center', gap: 7.5, border: 0, borderRadius: 5.625, color: 'var(--background)', background: 'var(--foreground)', opacity: disabled ? .5 : 1, fontSize: 13.125, fontWeight: 500 }}>{submitting ? <CubeSpinner style={{ fontSize: 13.125 }} /> : null}{submitting ? '创建中…' : '创建组织'}</button>
    </form>
  </CardFrame>
}

// rounded-xl border p-4; selected accent border + accent/5 wash; check chip
// right-3 top-3 size-5 with a size-3 Check; size-5 accent icon; 14px medium
// title at mt-3; 12px/20px muted description at mt-1.
function TypeCard({ selected, disabled, icon: Icon, title, description, onClick }) {
  return <button type="button" aria-pressed={selected} disabled={disabled} onClick={onClick} style={{ position: 'relative', padding: 15, border: `1px solid ${selected ? 'var(--accent)' : border70}`, borderRadius: 11.25, color: 'var(--foreground)', background: selected ? 'color-mix(in srgb, var(--accent) 5%, transparent)' : 'transparent', textAlign: 'left', transition: 'border-color 150ms, background-color 150ms' }}>
    {selected && <span style={{ position: 'absolute', top: 11.25, right: 11.25, display: 'flex', width: 18.75, height: 18.75, alignItems: 'center', justifyContent: 'center', borderRadius: 9999, color: 'var(--background)', background: 'var(--accent)' }}><Check size={11.25} /></span>}
    <Icon size={18.75} style={{ color: 'var(--accent)' }} />
    <span style={{ display: 'block', marginTop: 11.25, fontSize: 13.125, fontWeight: 500 }}>{title}</span>
    <small style={{ display: 'block', marginTop: 3.75, color: muted, fontSize: 11.25, lineHeight: '18.75px' }}>{description}</small>
  </button>
}

// SpinKit grid spinner (LoadingIndicator.tsx): keyframes live in base.css.
function CubeSpinner({ style }) {
  const cubeStyle = { backgroundColor: 'currentColor', animation: 'spinner-grid 1.3s infinite ease-in-out', transform: 'scale3d(0.5,0.5,1)' }
  const delays = [0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0, 0.1, 0.2]
  return <span role="status" aria-label="加载中" style={{ display: 'inline-grid', gridTemplateColumns: 'repeat(3, 1fr)', width: '1em', height: '1em', gap: '0.08em', color: 'var(--foreground)', ...style }}>{delays.map((delay, index) => <span key={index} style={{ ...cubeStyle, animationDelay: delay + 's' }}/>)}</span>
}

// ui/Input: h-9 rounded-md border-foreground/15 text-sm.
const inputStyle = { width: '100%', height: 33.75, boxSizing: 'border-box', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, outline: 0, color: 'var(--foreground)', background: 'transparent', font: 'inherit', fontSize: 13.125, fontWeight: 400 }
