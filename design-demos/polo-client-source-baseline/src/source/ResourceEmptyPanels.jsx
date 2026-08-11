import { DatabaseZap, Webhook, Zap } from 'lucide-react'

// EntityListEmptyScreen.tsx as instantiated by SourcesListPanel.tsx,
// SkillsListPanel.tsx and AutomationsListPanel.tsx with a real empty dataset.
const copy = {
  sources: { Icon: DatabaseZap, title: 'No sources configured.', description: 'Sources connect your agent to external data — MCP servers, REST APIs, and local folders.' },
  skills: { Icon: Zap, title: 'No skills configured', description: 'Skills are reusable instructions that teach your agent specialized behaviors.' },
  automations: { Icon: Webhook, title: 'No automations configured', description: 'Automations run actions when events occur — execute commands on schedules, react to label changes, or trigger prompts automatically.' },
}
export function SourceResourceEmptyPanel({ kind }) {
  const { Icon, title, description } = copy[kind]
  return <div data-route={'resources/' + kind + '/empty'} style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, boxSizing: 'border-box', padding: '24px 24px 20%', color: 'var(--foreground)', textAlign: 'center' }}>
    <div style={{ display: 'grid', width: 40, height: 40, placeItems: 'center', marginBottom: 8, color: 'var(--muted-foreground)' }}><Icon size={40} strokeWidth={1.5}/></div>
    <div style={{ display: 'grid', maxWidth: 384, gap: 8 }}><strong style={{ fontSize: 14, fontWeight: 500, letterSpacing: '-.01em' }}>{title}</strong><p style={{ margin: 0, color: 'var(--muted-foreground)', fontSize: 12, lineHeight: 1.35 }}>{description}</p></div>
    <div style={{ display: 'flex', width: '100%', maxWidth: 384, justifyContent: 'center', gap: 12, marginTop: 12 }}><button type="button" style={{ display: 'inline-flex', height: 28, alignItems: 'center', padding: '0 12px', border: 0, borderRadius: 8, color: 'var(--foreground)', background: 'color-mix(in srgb, var(--foreground) 2%, transparent)', boxShadow: 'var(--shadow-minimal)', fontSize: 12, fontWeight: 500 }}>Learn more</button></div>
  </div>
}
export function SourceUnselectedResourceDetail(){return <div aria-label="Resource detail" style={{width:'100%',height:'100%',background:'var(--background)'}}/>}
