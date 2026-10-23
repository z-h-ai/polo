import { Check, CreditCard, Key, Cpu } from 'lucide-react'

// AdminLoginStep.tsx phone branch (PhoneAuthStep.tsx) and APISetupStep.tsx —
// fixed visible states with named deterministic fixtures. IPC round-trips
// (sending/resending the code, verifying, connecting) stay un-wired; the
// countdown on the verify state is a frozen snapshot (43s), the phone number
// and masked form follow maskMainlandPhone. Copy is zh-Hans from zh-Hans.json.
// Root font-size 15px; the card shell reuses the admin-login classes.

const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'

function LoginCard({ subtitle, children }) {
  return <div className="source-admin-login" style={{ height: '100%' }}><div className="source-admin-login__titlebar"/><main><section className="source-admin-login__card" aria-label="Admin 登录">
    <div className="source-admin-login__identity"><div className="source-admin-login__mark"><PoloAiSymbol/></div><h1>Polo AI</h1><p>{subtitle}</p></div>
    {children}
  </section></main></div>
}

function MethodTabs({ value, onChange }) {
  const tabs = [
    { id: 'phone', label: '验证码登录' },
    { id: 'password', label: '密码登录' },
  ]
  return <div role="tablist" aria-label="登录方式" style={{ marginTop: 18.75, display: 'grid', gridTemplateColumns: '1fr 1fr', padding: 3.75, borderRadius: 10, background: 'color-mix(in srgb, var(--foreground) 5%, transparent)' }}>
    {tabs.map(method => <button key={method.id} type="button" role="tab" aria-selected={value === method.id} onClick={() => onChange?.(method.id)} style={value === method.id
      ? { borderRadius: 8, padding: '7.5px 11.25px', fontSize: 13.125, fontWeight: 500, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', border: 0, cursor: 'pointer' }
      : { borderRadius: 8, padding: '7.5px 11.25px', fontSize: 13.125, color: 'var(--fg-50)', background: 'transparent', border: 0, cursor: 'pointer', transition: 'color 150ms' }}>{method.label}</button>)}
  </div>
}

const fieldGroup = { display: 'grid', gap: 7.5 }
const fieldLabel = { display: 'block', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', fontSize: 11.25, lineHeight: 1, fontWeight: 500 }
const sm = { display: 'grid', gap: 15 }
const hint = { margin: 0, color: 'var(--fg-50)', fontSize: 11.25, lineHeight: 1.4286 }

// phone entry form — phone + consent + 发送验证码 (fixture kept submittable).
function PhoneEntryForm() {
  return <form data-testid="phone-auth-entry" style={{ display: 'grid', gap: 15, marginTop: 18.75 }}>
    <div style={fieldGroup}>
      <label htmlFor="phone-auth-phone" style={fieldLabel}>手机号</label>
      <div style={{ display: 'flex', height: 41.25, overflow: 'hidden', borderRadius: 10, background: 'var(--fg-2)' }}>
        <span style={{ display: 'flex', alignItems: 'center', padding: '0 11.25px', borderRight: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', fontSize: 13.125, color: 'var(--fg-50)' }}>+86</span>
        <input id="phone-auth-phone" inputMode="numeric" autoComplete="tel-national" placeholder="请输入 11 位手机号" defaultValue="13812348000" style={{ flex: 1, minWidth: 0, height: 41.25, padding: '3.75px 11.25px', border: 0, borderRadius: 0, background: 'transparent', color: 'var(--foreground)', fontSize: 13.125, outline: 'none' }} />
      </div>
    </div>
    <label data-testid="phone-auth-consent" style={{ display: 'flex', alignItems: 'flex-start', gap: 7.5, fontSize: 11.25, lineHeight: '18.75px', color: 'var(--fg-50)', cursor: 'pointer' }}>
      <input type="checkbox" defaultChecked style={{ marginTop: 3.75, width: 13.125, height: 13.125, accentColor: 'var(--accent)' }} />
      <span>我已阅读并同意 <span style={{ color: 'color-mix(in srgb, var(--foreground) 80%, transparent)', textDecoration: 'underline', textUnderlineOffset: 2 }}>用户协议</span> 和 <span style={{ color: 'color-mix(in srgb, var(--foreground) 80%, transparent)', textDecoration: 'underline', textUnderlineOffset: 2 }}>隐私政策</span></span>
    </label>
    <button data-testid="phone-auth-send-code" type="submit" style={{ height: 41.25, border: 0, borderRadius: 10, background: 'var(--accent)', color: 'var(--background)', fontSize: 13.125, fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7.5, cursor: 'pointer' }}>发送验证码</button>
  </form>
}

// phone verify form — masked phone bar + code input + resend countdown
// (frozen 43s snapshot) + 继续 (disabled until a 6-digit code exists).
function PhoneVerifyForm() {
  return <form data-testid="phone-auth-verify" style={{ display: 'grid', gap: 15, marginTop: 18.75 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9.375px 11.25px', borderRadius: 10, background: 'color-mix(in srgb, var(--foreground) 5%, transparent)', fontSize: 13.125, lineHeight: 1.4 }}>
      <strong style={{ fontWeight: 500, color: 'var(--foreground)' }}>+86 138 •••• 8000</strong>
      <button type="button" style={{ color: 'var(--accent)', background: 'transparent', border: 0, padding: 0, fontSize: 13.125, cursor: 'pointer' }}>修改</button>
    </div>
    <div style={fieldGroup}>
      <label htmlFor="phone-auth-code" style={fieldLabel}>验证码</label>
      <div style={{ display: 'flex', gap: 7.5 }}>
        <input id="phone-auth-code" inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" defaultValue="" autoFocus style={{ flex: 1, minWidth: 0, height: 41.25, padding: '3.75px 11.25px', border: 0, borderRadius: 10, background: 'var(--fg-2)', color: 'var(--foreground)', fontSize: 13.125, letterSpacing: '0.25em', outline: 'none' }} />
        <button type="button" disabled style={{ flexShrink: 0, height: 41.25, padding: '3.75px 11.25px', border: `1px solid ${fg15}`, borderRadius: 10, background: 'var(--background)', color: 'var(--foreground)', fontSize: 13.125, fontWeight: 500, opacity: .5, cursor: 'not-allowed' }}>43 秒后重发</button>
      </div>
      <p style={hint}>验证码 5 分钟内有效。</p>
    </div>
    <button data-testid="phone-auth-continue" type="submit" disabled style={{ height: 41.25, border: 0, borderRadius: 10, background: 'var(--accent)', color: 'var(--background)', fontSize: 13.125, fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7.5, opacity: .5, cursor: 'not-allowed' }}>继续</button>
  </form>
}

// PhoneAuthStep in its entry and verify modes (AdminLoginStep phone branch).
export function SourcePhoneAuth({ state }) {
  return <LoginCard subtitle="验证手机号即可登录或注册">
    <MethodTabs value="phone"/>
    {state === 'verify' ? <PhoneVerifyForm /> : <PhoneEntryForm />}
  </LoginCard>
}

// ---------------------------------------------------------------------------
// APISetupStep.tsx — segmented provider control + option cards on the
// wizard StepFormLayout (primitives.tsx, same metrics as the wizard steps).
// Fixtures: anthropic segment with the API-key option selected, pi segment
// with GitHub Copilot selected.
// ---------------------------------------------------------------------------

const stepButton = { display: 'inline-flex', flex: 1, maxWidth: 320, height: 33.75, alignItems: 'center', justifyContent: 'center', gap: 7.5, border: 0, borderRadius: 8, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', fontSize: 13.125, fontWeight: 500 }

function ApiStepFrame({ title, description, actions, children }) {
  return <div data-route="lifecycle/onboarding" style={{ position: 'relative', display: 'flex', width: '100%', height: '100%', minHeight: 0, flexDirection: 'column', boxSizing: 'border-box', padding: 30, overflowY: 'auto', background: 'var(--fg-2)', color: 'var(--foreground)' }}>
    <div aria-hidden="true" style={{ position: 'fixed', inset: '0 0 auto', zIndex: 40, height: 50 }} />
    <main style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', width: '100%', maxWidth: 420, flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 18.75, fontWeight: 600, lineHeight: '28px', letterSpacing: '-.025em' }}>{title}</h1>
          <p style={{ maxWidth: 360, margin: '7.5px 0 0', color: 'var(--fg-50)', fontSize: 13.125, lineHeight: 1.4286 }}>{description}</p>
        </div>
        <div style={{ width: '100%', marginTop: 22.5 }}>{children}</div>
        <div style={{ display: 'flex', width: '100%', flexShrink: 0, gap: 11.25, justifyContent: 'center', marginTop: 30 }}>{actions}</div>
      </div>
    </main>
  </div>
}

function BetaBadge() {
  return <span style={{ display: 'inline', marginLeft: 3.75, position: 'relative', top: -1, padding: '2px 5.625px 3px', fontSize: 10, fontWeight: 700, borderRadius: 4, background: 'var(--accent)', color: 'var(--background)' }}>Beta</span>
}

const apiOptions = [
  { id: 'claude_oauth', name: 'Claude Pro / Max', description: '使用 Claude 订阅获得无限访问。', icon: <CreditCard size={15} />, segment: 'anthropic' },
  { id: 'anthropic_api_key', name: 'Anthropic API 密钥', description: '通过 Anthropic、OpenRouter 或兼容 API 按量付费。', icon: <Key size={15} />, segment: 'anthropic' },
  { id: 'pi_chatgpt_oauth', name: 'ChatGPT Plus', description: '通过 Polo AI Backend 使用 ChatGPT 订阅。', icon: <Cpu size={15} />, segment: 'pi' },
  { id: 'pi_copilot_oauth', name: 'GitHub Copilot', description: '通过 Polo AI Backend 使用 GitHub Copilot 订阅。', icon: <Cpu size={15} />, segment: 'pi' },
  { id: 'pi_api_key', name: 'API 密钥', description: '通过 Polo AI Backend 使用提供商预设 (Anthropic、OpenAI、Google 等)。', icon: <Key size={15} />, segment: 'pi' },
]

export function SourceApiSetup({ segment }) {
  const isPi = segment === 'pi'
  const segmentLabel = isPi ? 'Polo AI Backend' : 'Claude'
  const segmentDescription = isPi
    ? <span>使用 Polo AI Backend 作为主智能体。通过 ChatGPT、GitHub Copilot 或 API 密钥连接。<BetaBadge /></span>
    : <span>使用 Claude Agent SDK 作为主智能体。通过 Claude 订阅或 API 密钥配置。</span>
  const selectedId = isPi ? 'pi_copilot_oauth' : 'anthropic_api_key'
  const options = apiOptions.filter(option => option.segment === segment)
  return <ApiStepFrame title="设置智能体" description="选择 AI 智能体的驱动方式。稍后可以添加更多连接。" actions={<>
    <button type="button" style={{ ...stepButton, flex: '0 1 auto', maxWidth: 'none', background: 'var(--fg-2)' }}>返回</button>
    <button type="button" style={{ ...stepButton, flex: '0 1 auto', maxWidth: 'none' }}>继续</button>
  </>}>
    <div style={{ display: 'flex', padding: 3.75, marginBottom: 15, borderRadius: 11.25, background: 'color-mix(in srgb, var(--foreground) 3%, transparent)' }}>
      {['anthropic', 'pi'].map(seg => <button key={seg} type="button" style={seg === segment ? { flex: 1, padding: '7.5px 15px', fontSize: 13.125, fontWeight: 500, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', border: 0, cursor: 'pointer' } : { flex: 1, padding: '7.5px 15px', fontSize: 13.125, fontWeight: 500, borderRadius: 8, background: 'transparent', border: 0, color: 'var(--fg-50)', cursor: 'pointer' }}>{seg === 'anthropic' ? 'Claude' : 'Polo AI Backend'}</button>)}
    </div>
    <div style={{ padding: 15, marginBottom: 11.25, borderRadius: 8, background: 'var(--fg-2)' }}>
      <p style={{ margin: 0, fontSize: 13.125, color: 'var(--fg-50)', textAlign: 'center', lineHeight: 1.4286 }}>{segmentDescription}</p>
    </div>
    <div style={{ display: 'grid', gap: 11.25, minHeight: 180, alignContent: 'start' }}>
      {options.map(option => {
        const selected = option.id === selectedId
        return <button key={option.id} type="button" style={{ display: 'flex', width: '100%', alignItems: 'flex-start', gap: 15, padding: 15, borderRadius: 11.25, textAlign: 'left', background: selected ? 'var(--background)' : 'var(--fg-2)', boxShadow: 'var(--shadow-minimal)', transition: 'background-color 150ms' }}>
          <div style={{ display: 'flex', width: 37.5, height: 37.5, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 8.25, background: selected ? 'color-mix(in srgb, var(--foreground) 10%, transparent)' : 'var(--fg-5)', color: selected ? 'var(--foreground)' : 'var(--fg-50)' }}>{option.icon}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 500, fontSize: 13.125, lineHeight: 1.35 }}>{option.name}</span>
            <p style={{ margin: '3.75px 0 0', color: 'var(--fg-50)', fontSize: 12, lineHeight: 1.35 }}>{option.description}</p>
          </div>
          <div style={{ display: 'flex', width: 18.75, height: 18.75, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 9999, border: '2px solid', borderColor: selected ? 'var(--foreground)' : 'color-mix(in srgb, var(--fg-50) 20%, transparent)', background: selected ? 'var(--foreground)' : 'transparent', color: 'var(--background)' }}>{selected && <Check size={11.25} strokeWidth={3} />}</div>
        </button>
      })}
    </div>
  </ApiStepFrame>
}

function PoloAiSymbol() { return <svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><path d="M 22 85 V 10 H 44 A 19 19 0 0 1 44 48 H 34" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="42" cy="76" r="9" fill="currentColor"/><path d="M 60 65 V 85 H 68" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="84" cy="76" r="9" fill="currentColor"/></svg> }