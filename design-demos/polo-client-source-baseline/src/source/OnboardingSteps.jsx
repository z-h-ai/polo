import { useState } from 'react'
import { Check, Download, Eye, Key, Monitor, RefreshCw } from 'lucide-react'
// Shared token used by module-level style objects; keep the declaration above
// its first use so module init stays TDZ-safe when bundled into one chunk.
const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'
import claudeIcon from '../../assets/provider-icons/claude.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import copilotIcon from '../../assets/provider-icons/copilot.svg'

// Direct translation of the OnboardingWizard.tsx step chain after Welcome:
// GitBashWarning.tsx, ProviderSelectStep.tsx, LocalModelStep.tsx and
// CredentialsStep.tsx. Each step is a fixed visible state (idle/default form
// values) — IPC validation callbacks stay un-wired. Copy is zh-Hans from
// zh-Hans.json; the provider card descriptions for api_key/local keep the
// source's hardcoded English strings. Root font-size is 15px: rem values are
// written verbatim in px (p-4 = 15px, text-sm = 13.125px, rounded-xl = 11.25px,
// max-w-[28rem] = 420px, size-10 = 37.5px, h-8 = 30px).
export function SourceOnboardingStep({ step }) {
  if (step === 'git-bash') return <WizardFrame><SourceGitBashWarning /></WizardFrame>
  if (step === 'provider-select') return <WizardFrame><SourceProviderSelect /></WizardFrame>
  if (step === 'local-model') return <WizardFrame><SourceLocalModel /></WizardFrame>
  if (step === 'credentials') return <WizardFrame><SourceCredentials /></WizardFrame>
  if (step === 'copilot-code') return <WizardFrame><SourceCopilotDeviceCode /></WizardFrame>
  if (step === 'claude-code') return <WizardFrame><SourceClaudeAuthCode /></WizardFrame>
  return null
}

// OnboardingWizard.tsx page shell: p-4 sm:p-8 → 30px at the review viewport,
// full-height column with the content centered.
function WizardFrame({ children }) {
  return <div data-route="lifecycle/onboarding" style={{ position: 'relative', display: 'flex', width: '100%', height: '100%', minHeight: 0, flexDirection: 'column', boxSizing: 'border-box', padding: 30, overflowY: 'auto', background: 'var(--fg-2)', color: 'var(--foreground)' }}>
    <div aria-hidden="true" style={{ position: 'fixed', inset: '0 0 auto', zIndex: 40, height: 50 }} />
    <main style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>{children}</main>
  </div>
}

// primitives.tsx StepFormLayout: w-full max-w-[28rem] (420px) centered column;
// StepHeader h1 step-title text-lg (18.75px) font-semibold tracking-tight,
// description mt-2 text-sm max-w-sm; content mt-6 w-full.
function StepFormLayout({ iconElement, title, description, actions, children }) {
  return <div style={{ display: 'flex', width: '100%', maxWidth: 420, flexDirection: 'column', alignItems: 'center' }}>
    {iconElement && <div style={{ marginBottom: 22.5, flexShrink: 0 }}>{iconElement}</div>}
    <div style={{ flexShrink: 0, textAlign: 'center' }}>
      <h1 style={{ margin: 0, fontSize: 18.75, fontWeight: 600, lineHeight: '28px', letterSpacing: '-.025em' }}>{title}</h1>
      {description && <p style={{ maxWidth: 360, margin: '7.5px 0 0', color: 'var(--fg-50)', fontSize: 13.125, lineHeight: 1.4286 }}>{description}</p>}
    </div>
    {children && <div style={{ width: '100%', marginTop: 22.5 }}>{children}</div>}
    {actions && <div style={{ display: 'flex', width: '100%', flexShrink: 0, gap: 11.25, justifyContent: 'center', marginTop: 30 }}>{actions}</div>}
  </div>
}

// primitives.tsx BackButton (ghost bg-foreground-2 shadow-minimal rounded-lg
// flex-1 max-w-[320px]) / ContinueButton (bg-background shadow-minimal).
// button.tsx default: h-9 = 33.75px, px-4 = 15px, text-sm = 13.125px.
const stepButton = { display: 'inline-flex', flex: 1, maxWidth: 320, height: 33.75, alignItems: 'center', justifyContent: 'center', gap: 7.5, border: 0, borderRadius: 8, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', fontSize: 13.125, fontWeight: 500, transition: 'background-color 150ms' }
const backStyle = { ...stepButton, background: 'var(--fg-2)' }
// ui/Input: h-9 rounded-md border-foreground/15 bg-background px-3 text-sm.
const inputStyle = { width: '100%', height: 33.75, boxSizing: 'border-box', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, outline: 0, color: 'var(--foreground)', background: 'var(--background)', font: 'inherit', fontSize: 13.125 }
// ui/Label: text-sm font-medium.
const labelStyle = { fontSize: 13.125, fontWeight: 500, lineHeight: 1 }

// GitBashWarning.tsx visible default: two rounded-lg border bg-foreground-2
// p-4 cards (Download / already-installed) and a BackButton. The expanded
// custom-path input only appears after "浏览..." — shown as the wizard's
// alternate state in the browser fixture instead.
function SourceGitBashWarning() {
  return <StepFormLayout
    title="需要 Git Bash"
    description="Polo AI 需要 Git Bash 在 Windows 上运行 shell 命令。未在系统中找到。"
    actions={<button type="button" style={{ ...backStyle, flex: '0 1 auto', maxWidth: 'none' }}>返回</button>}
  >
    <div style={{ display: 'grid', gap: 15 }}>
      <section style={{ padding: 15, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--fg-2)' }}>
        <h3 style={{ margin: 0, fontSize: 13.125, fontWeight: 500, color: 'var(--foreground)' }}>安装 Git for Windows</h3>
        <p style={{ margin: '3.75px 0 0', color: 'var(--fg-50)', fontSize: 12, lineHeight: 1.35 }}>获取 Git Bash 最简单的方式。免费且包含所需一切。</p>
        <button type="button" style={{ ...stepButton, width: '100%', maxWidth: 'none', height: 30, marginTop: 11.25, fontSize: 12 }}><Download size={15} style={{ marginRight: 7.5 }} />下载 Git for Windows</button>
      </section>
      <section style={{ padding: 15, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--fg-2)' }}>
        <h3 style={{ margin: 0, fontSize: 13.125, fontWeight: 500, color: 'var(--foreground)' }}>已安装 Git?</h3>
        <p style={{ margin: '3.75px 0 0', color: 'var(--fg-50)', fontSize: 12, lineHeight: 1.35 }}>如果 Git 安装在非标准位置，可以指定 bash.exe 的路径。</p>
        <div style={{ display: 'flex', gap: 7.5, marginTop: 11.25 }}>
          <button type="button" style={{ ...stepButton, flex: 1, maxWidth: 'none', height: 30, fontSize: 12 }}><RefreshCw size={15} style={{ marginRight: 7.5 }} />重新检查</button>
          <button type="button" style={{ ...stepButton, height: 30, fontSize: 12 }}>浏览...</button>
        </div>
      </section>
    </div>
  </StepFormLayout>
}

// ProviderSelectStep.tsx: PoloAiSymbol size-10 accent inside a size-16 flex
// icon slot, then five provider cards (rounded-xl bg-foreground-2 p-4 gap-4,
// 40px rounded-lg bg-muted icon tile, 13.125px medium name, 12px muted
// description) plus the centered 稍后设置 text button.
function SourceProviderSelect() {
  const options = [
    { id: 'claude', name: 'Claude Pro / Max', description: '使用 Claude 订阅获得无限访问。', icon: <img src={claudeIcon} alt="" style={{ width: 18.75, height: 18.75, borderRadius: 2.25 }} /> },
    { id: 'chatgpt', name: 'Codex · ChatGPT Plus', description: '使用 ChatGPT 订阅驱动 Polo AI。', icon: <img src={openaiIcon} alt="" style={{ width: 18.75, height: 18.75, borderRadius: 2.25 }} /> },
    { id: 'copilot', name: 'GitHub Copilot', description: '使用 GitHub Copilot 订阅驱动 Polo AI。', icon: <img src={copilotIcon} alt="" style={{ width: 18.75, height: 18.75, borderRadius: 2.25 }} /> },
    { id: 'api_key', name: '使用其他提供商', description: 'Anthropic, AWS Bedrock, OpenRouter, Google or any compatible provider.', icon: <Key size={18.75} /> },
    { id: 'local', name: '本地模型', description: 'Run models locally with Ollama.', icon: <Monitor size={18.75} /> },
  ]
  return <StepFormLayout
    iconElement={<div style={{ display: 'flex', width: 60, height: 60, alignItems: 'center', justifyContent: 'center' }}><PoloAiSymbol style={{ width: 37.5, height: 37.5, color: 'var(--accent)' }} /></div>}
    title="欢迎使用 Polo AI"
    description="选择连接方式"
    actions={<div style={{ width: '100%', textAlign: 'center' }}><button type="button" style={{ border: 0, background: 'transparent', color: 'var(--fg-50)', fontSize: 12, cursor: 'pointer' }}>稍后设置</button></div>}
  >
    <div style={{ display: 'grid', gap: 11.25 }}>
      {options.map(option => <button key={option.id} type="button" style={{ display: 'flex', width: '100%', alignItems: 'flex-start', gap: 15, padding: 15, border: 0, borderRadius: 11.25, background: 'var(--fg-2)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', textAlign: 'left', transition: 'background-color 150ms' }}>
        <div style={{ display: 'flex', width: 37.5, height: 37.5, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 8.25, background: 'var(--fg-5)', color: 'var(--fg-50)' }}>{option.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 500, fontSize: 13.125 }}>{option.name}</span>
          <p style={{ margin: 0, color: 'var(--fg-50)', fontSize: 12, lineHeight: 1.35 }}>{option.description}</p>
        </div>
      </button>)}
    </div>
  </StepFormLayout>
}

// LocalModelStep.tsx default form values: endpoint http://localhost:11434,
// model qwen3-coder. Inputs sit in a rounded-md shadow-minimal bg-foreground-2
// shell with focus-within:bg-background; helpers are text-xs
// text-foreground/30.
function SourceLocalModel() {
  const [endpoint, setEndpoint] = useState('http://localhost:11434')
  const [model, setModel] = useState('qwen3-coder')
  return <StepFormLayout
    title="本地模型"
    description="连接到 Ollama 或任何 OpenAI 兼容的本地服务器。"
    actions={<>
      <button type="button" style={backStyle}>返回</button>
      <button type="button" style={{ ...stepButton, opacity: 1 }}>继续</button>
    </>}
  >
    <form onSubmit={event => event.preventDefault()} style={{ display: 'grid', gap: 22.5 }}>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label htmlFor="local-base-url" style={labelStyle}>端点</label>
        <div style={{ borderRadius: 5.625, boxShadow: 'var(--shadow-minimal)', background: 'var(--fg-2)' }}>
          <input id="local-base-url" type="text" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="http://localhost:11434" style={{ ...inputStyle, border: 0, background: 'transparent', boxShadow: 'none' }} />
        </div>
        <p style={{ margin: 0, color: 'color-mix(in srgb, var(--foreground) 30%, transparent)', fontSize: 12 }}>默认 Ollama 端口为 11434。如使用自定义设置请更改。</p>
      </div>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label htmlFor="local-model" style={labelStyle}>模型 <span style={{ color: 'color-mix(in srgb, var(--foreground) 30%, transparent)', fontWeight: 400 }}>· 必填</span></label>
        <div style={{ borderRadius: 5.625, boxShadow: 'var(--shadow-minimal)', background: 'var(--fg-2)' }}>
          <input id="local-model" type="text" value={model} onChange={event => setModel(event.target.value)} placeholder="如 qwen3-coder, llama3.3" style={{ ...inputStyle, border: 0, background: 'transparent', boxShadow: 'none' }} />
        </div>
        <p style={{ margin: 0, color: 'color-mix(in srgb, var(--foreground) 30%, transparent)', fontSize: 12 }}>使用通过 ollama pull 拉取的任何模型。多个模型用逗号分隔。</p>
      </div>
    </form>
  </StepFormLayout>
}

// CredentialsStep.tsx API-key branch: ApiSetupStep with the ApiKeyInput
// control — provider preset menu (Endpoint), password-style key field with an
// eye toggle (pr-10), Base URL input. The fixture keeps the preset menu closed
// (its open popover belongs to interaction, not a static state).
function SourceCredentials() {
  const [showKey, setShowKey] = useState(false)
  return <StepFormLayout
    title="API 配置"
    description="通过 Polo AI Backend 使用提供商预设 (Anthropic、OpenAI、Google 等)。"
    actions={<>
      <button type="button" style={backStyle}>返回</button>
      <button type="button" style={stepButton}>连接</button>
    </>}
  >
    <div style={{ display: 'grid', gap: 15 }}>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label htmlFor="api-preset" style={labelStyle}>提供商预设</label>
        <button type="button" id="api-preset" style={{ display: 'flex', width: '100%', height: 33.75, alignItems: 'center', justifyContent: 'space-between', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 13.125 }}>
          <span>Anthropic</span>
          <ChevronDownGlyph />
        </button>
      </div>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label htmlFor="api-key" style={labelStyle}>API 密钥</label>
        <div style={{ position: 'relative' }}>
          <input id="api-key" type={showKey ? 'text' : 'password'} placeholder="sk-ant-..." style={{ ...inputStyle, paddingRight: 37.5 }} />
          <button type="button" aria-label={showKey ? '隐藏密码' : '显示密码'} onClick={() => setShowKey(value => !value)} style={{ position: 'absolute', top: 0, right: 0, display: 'grid', width: 37.5, height: 33.75, placeItems: 'center', border: 0, background: 'transparent', color: 'var(--fg-50)' }}><Eye size={15} /></button>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label htmlFor="api-base-url" style={labelStyle}>Base URL</label>
        <input id="api-base-url" type="text" placeholder="https://api.anthropic.com" style={inputStyle} />
      </div>
    </div>
  </StepFormLayout>
}

// The Copilot device-code card, as rendered by CredentialsStep's GitHub
// branch once a device code exists — a deterministic fixture code, not a
// runtime value. Exposed as its own named state in the router.
export function SourceCopilotDeviceCode() {
  return <StepFormLayout
    title="连接 GitHub Copilot"
    description="使用 GitHub Copilot 订阅驱动 Polo AI。"
    actions={<>
      <button type="button" style={backStyle}>返回</button>
      <button type="button" style={stepButton}>连接</button>
    </>}
  >
    <div style={{ display: 'grid', gap: 15 }}>
      <section style={{ padding: 15, borderRadius: 11.25, background: 'var(--fg-2)', fontSize: 13.125, color: 'var(--fg-50)', textAlign: 'center' }}>
        <p style={{ margin: 0, textAlign: 'left' }}>点击上方按钮使用 GitHub 账号登录。</p>
        <p style={{ margin: '11.25px 0 0' }}>在 GitHub 上输入此代码以授权:</p>
        <button type="button" style={{ display: 'inline-flex', alignItems: 'center', marginTop: 11.25, padding: '7.5px 15px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--background)', color: 'var(--foreground)', fontFamily: 'var(--font-mono)', fontSize: 25, fontWeight: 700, letterSpacing: '0.1em', cursor: 'pointer' }}>POL O-41</button>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3.75, marginTop: 7.5, opacity: 0, fontSize: 12, color: 'var(--fg-50)' }}><Check size={12} />已复制到剪贴板</span>
      </section>
    </div>
  </StepFormLayout>
}

// The Claude OAuth "waiting for authorization code" branch
// (CredentialsStep isWaitingForCode): OAuthConnect's code input card.
export function SourceClaudeAuthCode() {
  return <StepFormLayout
    title="输入授权码"
    description="从浏览器页面复制代码并粘贴到下方。"
    actions={<>
      <button type="button" style={backStyle}>取消</button>
      <button type="button" style={stepButton}>连接</button>
    </>}
  >
    <div style={{ display: 'grid', gap: 15 }}>
      <section style={{ padding: 15, borderRadius: 11.25, background: 'var(--fg-2)', fontSize: 13.125, color: 'var(--fg-50)' }}>
        <p style={{ margin: 0 }}>浏览器应已打开 github.com/login/device 的 Claude 授权页面。</p>
      </section>
      <div style={{ display: 'grid', gap: 7.5 }}>
        <label htmlFor="claude-auth-code" style={labelStyle}>授权码</label>
        <input id="claude-auth-code" type="text" placeholder="粘贴授权码…" style={inputStyle} />
      </div>
    </div>
  </StepFormLayout>
}

function ChevronDownGlyph() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13.125" height="13.125" style={{ opacity: .5, flexShrink: 0 }} aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg> }
function PoloAiSymbol({ style }) { return <svg viewBox="0 0 100 100" fill="none" aria-hidden="true" style={style}><path d="M 22 85 V 10 H 44 A 19 19 0 0 1 44 48 H 34" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="42" cy="76" r="9" fill="currentColor"/><path d="M 60 65 V 85 H 68" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="84" cy="76" r="9" fill="currentColor"/></svg> }
