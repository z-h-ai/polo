import { AlertCircle, LogIn, Monitor, RefreshCw } from 'lucide-react'

// Fixed Renderer lifecycle fixtures. These components mirror SplashScreen.tsx,
// ReauthScreen.tsx and the onboarding steps that OnboardingWizard.tsx selects.
// IPC callbacks are deliberately not simulated: their runtime outcome belongs
// to Electron authentication, not the visual prototype. Copy is zh-Hans, the
// prototype's default locale, taken verbatim from zh-Hans.json.
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
  return <div data-route="lifecycle/reauth" style={fullscreen('var(--fg-2)')}>
    <Titlebar />
    <main style={centeredMain}>
      <div style={formLayout}>
        <div style={{ display: 'grid', width: 64, height: 64, placeItems: 'center', marginBottom: 24, borderRadius: 9999, color: 'var(--info)', background: 'color-mix(in srgb, var(--info) 10%, transparent)' }}><AlertCircle size={32} /></div>
        <div style={{ textAlign: 'center' }}>
          <h1 style={stepTitle}>会话已过期</h1>
          <p style={stepDescription}>Polo AI 会话已过期或不再有效。<br/>请重新登录以继续使用 Polo AI。<br/><span style={{ display: 'block', marginTop: 8, color: 'color-mix(in srgb, var(--fg-50) 70%, transparent)', fontSize: 12 }}>对话和设置已保留。</span></p>
        </div>
        {failure && <div style={{ width: '100%', boxSizing: 'border-box', marginTop: 24, padding: 12, border: '1px solid color-mix(in srgb, var(--destructive) 20%, transparent)', borderRadius: 8, color: 'var(--destructive)', background: 'color-mix(in srgb, var(--destructive) 10%, transparent)', fontSize: 14 }}>Login failed</div>}
        {/* ReauthScreen stacks its buttons left-aligned inside a centered
            column: justify-center wrapper, w-full max-w-[320px] buttons. */}
        <div style={{ display: 'flex', width: '100%', justifyContent: 'center', gap: 12, marginTop: 24 }}>
          <div style={{ display: 'flex', width: '100%', maxWidth: 320, flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
            <button type="button" style={primarySurfaceButton}><RefreshCw size={16} style={{ marginRight: 8 }} />使用 Polo AI 登录</button>
            <button type="button" style={secondarySurfaceButton}>重置应用并重新开始...</button>
          </div>
        </div>
      </div>
    </main>
  </div>
}

function Welcome() {
  return <div data-route="lifecycle/onboarding/welcome" style={fullscreen('var(--fg-2)')}>
    <Titlebar />
    <main style={centeredMain}><div style={formLayout}>
      <div style={{ display: 'grid', width: 64, height: 64, placeItems: 'center', marginBottom: 24 }}><PoloAiSymbol style={{ width: 40, height: 40, color: 'var(--accent)' }}/></div>
      <div style={{ textAlign: 'center' }}><h1 style={stepTitle}>欢迎使用 Polo AI</h1><p style={stepDescription}>让智能体拥有应得的体验。连接一切。整理会话。做出一生中最好的工作所需的一切!</p></div>
      <div style={stackedActions}><button type="button" style={primarySurfaceButton}>开始使用</button></div>
    </div></main>
  </div>
}

function AdminKicked() {
  return <div data-route="lifecycle/onboarding/admin-kicked" style={fullscreen('var(--fg-2)')}>
    <Titlebar />
    <main style={centeredMain}><section aria-label="Admin 会话已结束" style={{ width: '100%', maxWidth: 384, boxSizing: 'border-box', padding: 28, border: '1px solid rgba(255,255,255,.2)', borderRadius: 20, textAlign: 'center', background: 'color-mix(in srgb, var(--background) 72%, transparent)', boxShadow: 'var(--shadow-modal-small)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }}>
      <div style={{ display: 'grid', width: 56, height: 56, placeItems: 'center', margin: '0 auto', borderRadius: 16, color: 'var(--foreground)', background: 'var(--fg-2)' }}><Monitor size={28}/></div>
      <h1 style={{ ...stepTitle, marginTop: 20, fontSize: 20 }}>已在其他设备登录</h1>
      <p style={{ ...stepDescription, marginTop: 12, lineHeight: '24px' }}>当前账号的登录状态已失效。为了保护账号安全，请重新登录后继续使用 Polo AI。</p>
      <button type="button" style={{ ...accentButton, width: '100%', height: 44, marginTop: 24, borderRadius: 10 }}><LogIn size={16}/>重新登录</button>
    </section></main>
  </div>
}

function Completion({ saving }) {
  return <div data-route={'lifecycle/onboarding/complete' + (saving ? '/saving' : '')} style={fullscreen('var(--fg-2)')}>
    <Titlebar />
    <main style={centeredMain}><div style={formLayout}>
      <div style={{ display: 'grid', width: 64, height: 64, placeItems: 'center', marginBottom: 24 }}>{saving ? <CubeSpinner style={{ fontSize: 24 }}/> : <PoloAiSymbol style={{ width: 40, height: 40, color: 'var(--accent)' }} />}</div>
      <div style={{ textAlign: 'center' }}><h1 style={stepTitle}>{saving ? '设置中...' : '一切就绪!'}</h1><p style={stepDescription}>{saving ? '正在保存配置...' : '开始聊天，开始工作。'}</p></div>
      {!saving && <div style={stackedActions}><button type="button" style={primarySurfaceButton}>开始使用</button></div>}
    </div></main>
  </div>
}

function Titlebar(){ return <div aria-hidden="true" style={{ position: 'fixed', inset: '0 0 auto', zIndex: 40, height: 50 }} /> }
function PoloAiSymbol({ style }) { return <svg viewBox="0 0 100 100" fill="none" aria-hidden="true" style={style}><path d="M 22 85 V 10 H 44 A 19 19 0 0 1 44 48 H 34" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="42" cy="76" r="9" fill="currentColor"/><path d="M 60 65 V 85 H 68" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="84" cy="76" r="9" fill="currentColor"/></svg> }
// SpinKit grid spinner from packages/ui LoadingIndicator.tsx + its CSS: 3x3
// cubes, 1em square, staggered scale animation, currentColor.
function CubeSpinner({ style }) {
  const cubeStyle = { backgroundColor: 'currentColor', animation: 'spinner-grid 1.3s infinite ease-in-out', transform: 'scale3d(0.5,0.5,1)' }
  const delays = [0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0, 0.1, 0.2]
  return <span role="status" aria-label="加载中" style={{ display: 'inline-grid', gridTemplateColumns: 'repeat(3, 1fr)', width: '1em', height: '1em', gap: '0.08em', color: 'var(--foreground)', ...style }}>{delays.map((delay, index) => <span key={index} style={{ ...cubeStyle, animationDelay: delay + 's' }}/>)}</span>
}
// Keyframes live in base.css (spinner-grid), translated from
// packages/ui/src/styles/index.css.
const fullscreen = (background) => ({ position: 'relative', display: 'flex', minHeight: '100%', height: '100%', flexDirection: 'column', background })
const centeredMain = { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }
const formLayout = { display: 'flex', width: '100%', maxWidth: 448, flexDirection: 'column', alignItems: 'center' }
// primitives.tsx step-title: text-lg (18px/28px) font-semibold tracking-tight;
// step-description: text-sm (14px/20px) max-w-sm (24rem = 360px at 15px root).
const stepTitle = { margin: 0, color: 'var(--foreground)', fontSize: 18, fontWeight: 600, lineHeight: '28px', letterSpacing: '-.025em' }
const stepDescription = { maxWidth: 360, margin: '8px 0 0', color: 'var(--fg-50)', fontSize: 14, lineHeight: '20px' }
const stackedActions = { display: 'flex', width: '100%', flexDirection: 'column', gap: 12, marginTop: 24 }
// button.tsx size="lg": h-10 (37.5px), rounded-md (5.625px), text-sm.
const primarySurfaceButton = { display: 'inline-flex', width: '100%', maxWidth: 320, height: 37.5, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', gap: 8, border: 0, borderRadius: 5.625, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', fontSize: 14, fontWeight: 500 }
// Reauth secondary: variant ghost size sm → h-8 (30px) text-xs.
const secondarySurfaceButton = { ...primarySurfaceButton, height: 30, fontSize: 12, background: 'var(--fg-2)' }
const accentButton = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, border: 0, color: 'var(--background)', background: 'var(--accent)', fontSize: 14, fontWeight: 500 }
