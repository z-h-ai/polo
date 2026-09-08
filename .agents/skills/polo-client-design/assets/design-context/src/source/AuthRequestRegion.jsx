import { CheckCircle2, Eye, EyeOff, Key, Lock, XCircle, User } from 'lucide-react'

// AuthRequestCard — inline auth UI the agent appends to chat history (or the
// chat messages surface appends for it). Static translations of
// src/renderer/components/chat/AuthRequestCard.tsx. Copy in the source is
// hardcoded English, kept literal; the Notion source name, description and
// hint are named deterministic fixtures filling the auth* message fields the
// Renderer reads. The `--success-text`/`--foreground-3` classes resolve to
// token-color equivalents in this baseline. Root font-size 15px.

const mutedForeground = 'var(--fg-50)'

// Card chrome — rounded-[8px] shadow-minimal borderless; the success variant
// tints the background with the success hue (VARIANT_STYLES) plus
// shadow-tinted. The cancelled variant uses a ~10% foreground wash with 70%
// opacity text (approximation of text-foreground/70 + var(--foreground-3)).
function Card({ variant, children }) {
  const base = { borderRadius: 8, overflow: 'hidden', border: 0, color: 'var(--foreground)' }
  if (variant === 'success') {
    base.background = 'color-mix(in srgb, var(--success) 6%, var(--background))'
    base.boxShadow = 'var(--shadow-tinted)'
    base['--shadow-color'] = 'var(--success-rgb)'
    base.color = 'var(--success)'
  } else if (variant === 'muted') {
    base.background = 'color-mix(in srgb, var(--foreground) 10%, transparent)'
    base.boxShadow = 'var(--shadow-minimal)'
    base.color = 'color-mix(in srgb, var(--foreground) 70%, transparent)'
  } else {
    base.background = 'var(--background)'
    base.boxShadow = 'var(--shadow-minimal)'
  }
  return <div style={base}>{children}</div>
}

function AuthHeader({ Icon, title, subtitle, subtitleSecondary, description, titleColor }) {
  return <div style={{ display: 'flex', gap: 11.25 }}>
    {Icon && <Icon size={15} style={{ flexShrink: 0, marginTop: 1.875 }} />}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13.125, fontWeight: 500, lineHeight: '18.75px', color: titleColor || 'inherit' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11.25, marginTop: 1.875, opacity: 0.5, lineHeight: 1.4286 }}>{subtitle}</div>}
      {subtitleSecondary && <div style={{ fontSize: 11.25, marginTop: 1.875, opacity: 0.5, lineHeight: 1.4286 }}>{subtitleSecondary}</div>}
      {description && <p style={{ margin: 0, marginTop: 3.75, fontSize: 11.25, lineHeight: 1.4286, color: mutedForeground }}>{description}</p>}
    </div>
  </div>
}

function AuthActions({ primaryLabel, primaryDisabled, secondaryLabel, hint }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, padding: '7.5px 11.25px', borderTop: '1px solid color-mix(in srgb, var(--border) 50%, transparent)' }}>
    <button type="button" disabled={primaryDisabled} style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', gap: 5.625, padding: '0 11.25px', borderRadius: 6, border: 0, background: 'var(--foreground)', color: 'var(--background)', fontSize: 11.25, fontWeight: 500, cursor: primaryDisabled ? 'not-allowed' : 'pointer', opacity: 1 }}>{primaryLabel}</button>
    <button type="button" style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', gap: 5.625, padding: '0 11.25px', borderRadius: 6, border: 0, background: 'transparent', color: mutedForeground, fontSize: 11.25, fontWeight: 500, cursor: 'pointer' }}>{secondaryLabel}</button>
    <div style={{ flex: 1 }} />
    {hint && <span style={{ fontSize: 10, color: mutedForeground }}>{hint}</span>}
  </div>
}

function Field({ label, placeholder, icon: Icon, type = 'password' }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 5.625 }}>
    <label style={{ fontSize: 11.25, color: 'var(--foreground)' }}>{label}</label>
    <div style={{ position: 'relative' }}>
      <Icon size={15} style={{ position: 'absolute', left: 11.25, top: '50%', transform: 'translateY(-50%)', color: mutedForeground, pointerEvents: 'none' }} />
      <input readOnly value="" type={type} placeholder={placeholder} style={{ width: '100%', height: 33.75, boxSizing: 'border-box', paddingLeft: 33.75, paddingRight: 33.75, borderRadius: 8, border: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', background: 'var(--background)', color: 'var(--foreground)', fontSize: 13.125, outline: 'none', userSelect: 'none' }} />
      <button type="button" aria-label="Toggle password visibility" tabIndex={-1} style={{ position: 'absolute', right: 11.25, top: '50%', transform: 'translateY(-50%)', display: 'flex', padding: 0, border: 0, background: 'none', color: mutedForeground, cursor: 'pointer' }}>
        {type === 'password' ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
    </div>
  </div>
}

function SceneFrame({ children }) {
  return <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'flex-start', padding: 22.5, background: 'var(--fg-2)', overflow: 'auto' }}>
    <div style={{ maxWidth: 'min(640px, 100%)' }}>{children}</div>
  </div>
}

// ---------------------------------------------------------------------------
// pending credential form — Notion, single API Key field (as an Input with
// the Key adornment), Save disabled while empty; hint below the field.
// ---------------------------------------------------------------------------

export function SourceAuthRequestCard() {
  return <div data-route="chat/auth-request">
    <SceneFrame>
      <Card variant="default">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 15, padding: 15 }}>
          <AuthHeader Icon={Key} title="Notion Authentication" description="Real-time agent actions need this connection to proceed." />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11.25 }}>
            <Field label="API Key" placeholder="Enter api key" icon={Key} />
            <p style={{ margin: 0, fontSize: 11, color: mutedForeground, lineHeight: 1.4286 }}>Credentials are encrypted at rest</p>
          </div>
        </div>
        <AuthActions primaryLabel="Save" primaryDisabled secondaryLabel="Cancel" hint="Credentials are encrypted at rest" />
      </Card>
    </SceneFrame>
  </div>
}

// ---------------------------------------------------------------------------
// completed — success tint (oklch success wash + shadow-tinted keyed to
// --success-rgb), CheckCircle2, `Notion Connected`, signed-in email.
// ---------------------------------------------------------------------------

export function SourceAuthRequestCompleted() {
  return <div data-route="chat/auth-completed">
    <SceneFrame>
      <div style={{ minWidth: 260 }}>
        <Card variant="success">
          <div style={{ padding: '11.25px 18.75px 11.25px 15px' }}>
            <AuthHeader Icon={CheckCircle2} title="Notion Connected" subtitle="Signed in as demo@example.com" />
          </div>
        </Card>
      </div>
    </SceneFrame>
  </div>
}

// ---------------------------------------------------------------------------
// cancelled — muted wash, XCircle, `Notion Cancelled` (no actions bar).
// ---------------------------------------------------------------------------

export function SourceAuthRequestCancelled() {
  return <div data-route="chat/auth-cancelled">
    <SceneFrame>
      <div style={{ minWidth: 260 }}>
        <Card variant="muted">
          <div style={{ padding: '11.25px 18.75px 11.25px 15px' }}>
            <AuthHeader Icon={XCircle} title="Notion Cancelled" />
          </div>
        </Card>
      </div>
    </SceneFrame>
  </div>
}

// ---------------------------------------------------------------------------
// Basic-auth variant (Username + Password fields) for completeness — renders
// the multi-field credential form with the Lock/User adornments.
// ---------------------------------------------------------------------------

export function SourceAuthRequestBasic() {
  return <div data-route="chat/auth-request-basic">
    <SceneFrame>
      <Card variant="default">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 15, padding: 15 }}>
          <AuthHeader Icon={Lock} title="Postgres Authentication" description="The agent needs a database login to run this query." />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11.25 }}>
            <Field label="Username" placeholder="Enter username" icon={User} type="text" />
            <Field label="Password" placeholder="Enter password" icon={Lock} />
            <p style={{ margin: 0, fontSize: 11, color: mutedForeground, lineHeight: 1.4286 }}>Credentials are encrypted at rest</p>
          </div>
        </div>
        <AuthActions primaryLabel="Save" primaryDisabled secondaryLabel="Cancel" hint="Credentials are encrypted at rest" />
      </Card>
    </SceneFrame>
  </div>
}