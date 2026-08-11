import { AlertCircle, LogIn, Monitor, RefreshCw } from 'lucide-react'

// Fixed Renderer lifecycle fixtures. These components mirror SplashScreen.tsx,
// ReauthScreen.tsx and the onboarding steps that OnboardingWizard.tsx selects.
// IPC callbacks are deliberately not simulated: their runtime outcome belongs
// to Electron authentication, not the visual prototype.
export function SourceLifecycleRegion({ scene, state }) {
  if (scene === 'splash') return <Splash />
  if (scene === 'reauth') return <Reauth failure={state === 'failure'} />
  if (scene === 'onboarding') {
    if (state === 'admin-kicked') return <AdminKicked />
    if (state === 'complete') return <Completion saving={false} />
    if (state === 'loading') return <Completion saving />
    return <Welcome />
  }
  return <Welcome />
}

function Splash() {
  return <div data-route="lifecycle/splash" style={fullscreen('var(--background)')}>
    {/* SplashScreen.tsx: inner initial state is scale 1.5 / opacity 1. */}
    <PoloAiSymbol style={{ width: 32, height: 32, transform: 'scale(1.5)', color: 'var(--accent)' }} />
  </div>
}

function Reauth({ failure }) {
  return <div data-route="lifecycle/reauth" style={fullscreen('var(--foreground-2, var(--background))')}>
    <Titlebar />
    <main style={centeredMain}>
      <div style={formLayout}>
        <div style={{ display: 'grid', width: 64, height: 64, placeItems: 'center', marginBottom: 24, borderRadius: 9999, color: 'var(--info)', background: 'color-mix(in srgb, var(--info) 10%, transparent)' }}><AlertCircle size={32} /></div>
        <div style={{ textAlign: 'center' }}>
          <h1 style={stepTitle}>Session Expired</h1>
          <p style={stepDescription}>Your Polo AI session has expired or is no longer valid.<br/>Please log in again to continue using Polo AI.<br/><span style={{ display: 'block', marginTop: 8, color: 'color-mix(in srgb, var(--muted-foreground) 70%, transparent)', fontSize: 12 }}>Your conversations and settings are preserved.</span></p>
        </div>
        {failure && <div style={{ width: '100%', boxSizing: 'border-box', marginTop: 16, padding: 12, border: '1px solid color-mix(in srgb, var(--destructive, #dc2626) 20%, transparent)', borderRadius: 8, color: 'var(--destructive, #dc2626)', background: 'color-mix(in srgb, var(--destructive, #dc2626) 10%, transparent)', fontSize: 14 }}>Login failed</div>}
        <div style={stackedActions}>
          <button type="button" style={primarySurfaceButton}><RefreshCw size={16} />Log In with Polo AI</button>
          <button type="button" style={secondarySurfaceButton}>Reset app and start fresh...</button>
        </div>
      </div>
    </main>
  </div>
}

function Welcome() {
  return <div data-route="lifecycle/onboarding/welcome" style={fullscreen('var(--foreground-2, var(--background))')}>
    <Titlebar />
    <main style={centeredMain}><div style={formLayout}>
      <div style={{ display: 'grid', width: 64, height: 64, placeItems: 'center', marginBottom: 24 }}><PoloAiSymbol style={{ width: 40, height: 40, color: 'var(--accent)' }}/></div>
      <div style={{ textAlign: 'center' }}><h1 style={stepTitle}>Welcome to Polo AI</h1><p style={stepDescription}>Agents with the UX they deserve. Connect anything. Organize your sessions. Everything you need to do the work of your life!</p></div>
      <div style={stackedActions}><button type="button" style={primarySurfaceButton}>Get Started</button></div>
    </div></main>
  </div>
}

function AdminKicked() {
  return <div data-route="lifecycle/onboarding/admin-kicked" style={fullscreen('var(--foreground-2, var(--background))')}>
    <Titlebar />
    <main style={centeredMain}><section aria-label="Admin session ended" style={{ width: '100%', maxWidth: 384, boxSizing: 'border-box', padding: 28, border: '1px solid rgba(255,255,255,.2)', borderRadius: 20, textAlign: 'center', background: 'color-mix(in srgb, var(--background) 72%, transparent)', boxShadow: 'var(--shadow-modal-small, 0 8px 30px rgba(0,0,0,.12))', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }}>
      <div style={{ display: 'grid', width: 56, height: 56, placeItems: 'center', margin: '0 auto', borderRadius: 16, color: 'var(--foreground)', background: 'var(--foreground-2, var(--background))' }}><Monitor size={28}/></div>
      <h1 style={{ ...stepTitle, marginTop: 20, fontSize: 20 }}>Signed in on another device</h1>
      <p style={{ ...stepDescription, marginTop: 12, lineHeight: 1.7 }}>Your account session is no longer valid. To keep your account secure, please sign in again to continue using Polo AI.</p>
      <button type="button" style={{ ...accentButton, width: '100%', height: 44, marginTop: 24, borderRadius: 10 }}><LogIn size={16}/>Sign in again</button>
    </section></main>
  </div>
}

function Completion({ saving }) {
  return <div data-route={'lifecycle/onboarding/complete' + (saving ? '/saving' : '')} style={fullscreen('var(--foreground-2, var(--background))')}>
    <Titlebar />
    <main style={centeredMain}><div style={formLayout}>
      <div style={{ display: 'grid', width: 64, height: 64, placeItems: 'center', marginBottom: 24 }}>{saving ? <span aria-label="Loading" style={{ width: 24, height: 24, border: '2px solid color-mix(in srgb, var(--foreground) 20%, transparent)', borderTopColor: 'var(--foreground)', borderRadius: 9999, animation: 'source-spin .8s linear infinite' }}/> : <PoloAiSymbol style={{ width: 40, height: 40, color: 'var(--accent)' }} />}</div>
      <div style={{ textAlign: 'center' }}><h1 style={stepTitle}>{saving ? 'Setting up...' : "You're all set!"}</h1><p style={stepDescription}>{saving ? 'Saving your configuration...' : 'Just start a chat and get to work.'}</p></div>
      {!saving && <div style={stackedActions}><button type="button" style={primarySurfaceButton}>Get Started</button></div>}
    </div></main>
  </div>
}

function Titlebar(){ return <div aria-hidden="true" style={{ position: 'fixed', inset: '0 0 auto', zIndex: 20, height: 50 }} /> }
function PoloAiSymbol({ style }) { return <svg viewBox="0 0 100 100" fill="none" aria-hidden="true" style={style}><path d="M 22 85 V 10 H 44 A 19 19 0 0 1 44 48 H 34" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="42" cy="76" r="9" fill="currentColor"/><path d="M 60 65 V 85 H 68" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="84" cy="76" r="9" fill="currentColor"/></svg> }
const fullscreen = (background) => ({ position: 'relative', display: 'flex', minHeight: '100%', height: '100%', flexDirection: 'column', background })
const centeredMain = { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }
const formLayout = { display: 'flex', width: '100%', maxWidth: 448, flexDirection: 'column', alignItems: 'center' }
const stepTitle = { margin: 0, color: 'var(--foreground)', fontSize: 18, fontWeight: 600, lineHeight: 1.25, letterSpacing: '-.025em' }
const stepDescription = { maxWidth: 384, margin: '8px 0 0', color: 'var(--muted-foreground)', fontSize: 14, lineHeight: 1.5 }
const stackedActions = { display: 'flex', width: '100%', flexDirection: 'column', gap: 12, marginTop: 24 }
const primarySurfaceButton = { display: 'inline-flex', width: '100%', maxWidth: 320, height: 44, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', gap: 8, border: 0, borderRadius: 8, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', fontSize: 14, fontWeight: 500 }
const secondarySurfaceButton = { ...primarySurfaceButton, height: 36, fontSize: 14, background: 'var(--foreground-2, var(--background))' }
const accentButton = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, border: 0, color: 'var(--background)', background: 'var(--accent)', fontSize: 14, fontWeight: 500 }
