import { Check, Copy, ExternalLink, Eye, EyeOff, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

// Static translation of the messaging connect/pairing dialog family:
//   - TelegramConnectDialog.tsx      (token test→save; reconfigure variant)
//   - WhatsAppConnectDialog.tsx      (Baileys QR phases: show_qr / connected)
//   - LarkConnectDialog.tsx          (App ID + App Secret + region selector)
//   - PairingCodeDialog.tsx          (6-digit code + /pair command)
//   - TelegramSupergroupPairingDialog.tsx (supergroup variant with bot link)
// Dialog chrome follows dialog.tsx (DialogContent max-w-[480px]/[440px]
// popover-styled p-6 gap-4, DialogHeader, DialogTitle text-lg leading-none
// font-semibold, DialogDescription text-sm text-muted-foreground; footer
// buttons are variant outline size sm).
//
// IPC-owned data is named deterministic fixture:
//   - testTelegramToken  success, botUsername "polo_official_bot"
//   - testLarkCredentials success; domain lark selected
//   - WhatsApp UI events  qr (fixture QR payload) → connected as 我的手机
//   - pairing codes       284731 (telegram) / 592640 (supergroup) with frozen
//     countdown values — the source recomputes seconds every second at
//     runtime, so the displayed expiry is a fixed snapshot
// All copy is zh-Hans via the flat keys in zh-Hans.json; no hardcoded English
// strings appear in these dialog sources.
const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'
const muted = 'var(--fg-50)'
const emerald = '#059669' // text-emerald-600 (dark:emerald-400 variant)
// Outline button (variant outline size sm): h-8 px-3 text-xs rounded-md
// border-foreground/15 bg-background.
const outlineSm = { display: 'inline-flex', height: 30, alignItems: 'center', gap: 7.5, padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500, cursor: 'pointer' }
// Button default (domain selector active): h-8 px-3 text-xs bg-foreground
// text-background.
const solidSm = { display: 'inline-flex', height: 30, alignItems: 'center', gap: 7.5, padding: '0 11.25px', border: 0, borderRadius: 5.625, background: 'var(--foreground)', color: 'var(--background)', fontSize: 11.25, fontWeight: 500, cursor: 'pointer' }
const disabledStyle = { opacity: 0.5 }

// SettingsSecretInput (settings/SettingsInput.tsx): wrapper relative
// rounded-md shadow-minimal bg-muted/50; input pr-10 bg-transparent border-0
// shadow-none; Eye/EyeOff toggle absolute right-3 top-1/2.
const secretWrap = { position: 'relative', borderRadius: 5.625, boxShadow: 'var(--shadow-minimal)', background: 'color-mix(in srgb, var(--muted) 50%, transparent)' }
const secretInput = { width: '100%', height: 33.75, boxSizing: 'border-box', padding: '0 37.5px 0 11.25px', border: 0, borderRadius: 5.625, outline: 0, color: 'var(--foreground)', background: 'transparent', fontSize: 13.125 }
const secretToggle = { position: 'absolute', right: 11.25, top: '50%', transform: 'translateY(-50%)', display: 'flex', padding: 0, border: 0, background: 'none', color: muted, cursor: 'pointer' }

function DialogFrame({ route, maxWidth, title, description, children, footer }) {
  return <div data-route={`messaging-dialog/${route}`} style={{ position: 'relative', display: 'grid', width: '100%', height: '100%', minHeight: 0, placeItems: 'center', background: 'rgba(0,0,0,.5)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby={`md-${route}-title`} style={{ position: 'relative', display: 'grid', width: 'min(480px, calc(100% - 32px))', maxWidth: maxWidth, gap: 15, boxSizing: 'border-box', padding: 22.5, borderRadius: 8, background: 'var(--background)', color: 'var(--foreground)', boxShadow: 'var(--shadow-modal-small)' }}>
      <button type="button" aria-label="Close" style={{ position: 'absolute', top: 15, right: 15, display: 'flex', padding: 0, border: 0, borderRadius: 2, background: 'none', color: 'inherit', opacity: 0.7, cursor: 'pointer' }}><X size={16} /></button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7.5 }}>
        <h2 id={`md-${route}-title`} style={{ margin: 0, fontSize: 18.75, lineHeight: 1, fontWeight: 600 }}>{title}</h2>
        {description && <p style={{ margin: 0, whiteSpace: 'pre-line', color: muted, fontSize: 13.125 }}>{description}</p>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 15, padding: '7.5px 0' }}>{children}</div>
      {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7.5 }}>{footer}</div>}
    </section>
  </div>
}

// status chip used by telegram/lark: inline-flex items-center gap-1 text-xs
// emerald-600 (or text-destructive for the error branch).
function StatusChip({ ok, children }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3.75, color: ok ? emerald : 'var(--destructive)', fontSize: 11.25 }}>{children}</span>
}

function SecretField({ placeholder, value }) {
  return <div style={secretWrap}>
    <input type="password" value={value} readOnly placeholder={placeholder} style={secretInput} />
    <button type="button" tabIndex="-1" aria-label="Show" style={secretToggle}><Eye size={16} /></button>
  </div>
}

export function SourceTelegramConnect() {
  // Fixture: token pasted from @BotFather, test success → bot credentials
  // badge, Save enabled.
  return <DialogFrame route="telegram-connect" title="连接 Telegram" description="1. 打开 Telegram 并搜索 @BotFather\n2. 发送 /newbot 并按提示操作\n3. 复制令牌并粘贴到此处" footer={<><button type="button" style={outlineSm}>取消</button><button type="button" style={outlineSm}>保存</button></>}>
    <div style={{ display: 'grid', gap: 11.25 }}>
      <SecretField placeholder="粘贴来自 @BotFather 的机器人令牌" value="7791234567:AAH-fixed-bot-token-fixture" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7.5 }}>
        <button type="button" style={outlineSm}>测试连接</button>
        <StatusChip ok><Check size={13.125} />有效机器人：@polo_official_bot</StatusChip>
      </div>
    </div>
  </DialogFrame>
}

export function SourceTelegramReconfigure() {
  // Reconfigure mode: replaces the existing token; empty field → idle test
  // state, Test and Save disabled exactly like the source.
  return <DialogFrame route="telegram-reconfigure" title="替换 Telegram 令牌" description="1. 打开 Telegram 并搜索 @BotFather\n2. 发送 /newbot 并按提示操作\n3. 复制令牌并粘贴到此处" footer={<><button type="button" style={{ ...outlineSm, ...disabledStyle }}>取消</button><button type="button" style={{ ...outlineSm, ...disabledStyle }}>保存</button></>}>
    <div style={{ display: 'grid', gap: 11.25 }}>
      <SecretField placeholder="粘贴来自 @BotFather 的机器人令牌" value="" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7.5 }}>
        <button type="button" style={{ ...outlineSm, ...disabledStyle }}>测试连接</button>
      </div>
    </div>
  </DialogFrame>
}

export function SourceWhatsAppQr() {
  // Phase show_qr: QR payload is IPC data, so the SVG encodes the named
  // fixture string; rendered inside the source's white p-4 rounded-lg tile.
  return <DialogFrame route="whatsapp-qr" title="连接 WhatsApp" description="链接您的 WhatsApp 账户，以便从此工作区接收和发送消息。">
    <p style={{ margin: 0, color: muted, fontSize: 11.25 }}>支持自聊：连接后，打开你自己的 WhatsApp 自聊并输入 /new 开始新会话，或输入 /pair &lt;代码&gt; 从应用中关联会话。</p>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 11.25, padding: '7.5px 0' }}>
      <div style={{ padding: 15, borderRadius: 7.5, background: '#ffffff' }}>
        <QRCodeSVG value="wa-session-qr-fixture/workspace-demo/2026-09" size={240} level="M" />
      </div>
      <p style={{ margin: 0, whiteSpace: 'pre-line', textAlign: 'center', color: muted, fontSize: 13.125 }}>在手机上：WhatsApp → 设置 → 已关联的设备 → 关联设备。扫描上方二维码。</p>
    </div>
  </DialogFrame>
}

export function SourceWhatsAppConnected() {
  // Phase connected: named fixture name → 已连接为 我的手机.
  return <DialogFrame route="whatsapp-connected" title="连接 WhatsApp" description="链接您的 WhatsApp 账户，以便从此工作区接收和发送消息。">
    <p style={{ margin: 0, color: muted, fontSize: 11.25 }}>支持自聊：连接后，打开你自己的 WhatsApp 自聊并输入 /new 开始新会话，或输入 /pair &lt;代码&gt; 从应用中关联会话。</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 15, padding: '7.5px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, fontSize: 13.125 }}><StatusChip ok><Check size={16} /></StatusChip><span>已连接为 我的手机</span></div>
    </div>
  </DialogFrame>
}

export function SourceLarkConnect() {
  // Fixture: App ID/App Secret filled, domain lark (active solid button),
  // test success → badge + Save enabled.
  return <DialogFrame route="lark-connect" title="连接 Lark / 飞书" description={<>
    1. 打开 Lark Open Platform（lark）或飞书开放平台（feishu）并创建自建应用{'\n'}
    2. 复制 App ID（cli_…）和 App Secret{'\n'}
    3. 启用 im:message + im:message.group_at_msg + im:message:send_as_bot 权限{'\n'}
    4. 使用「长连接模式」订阅 im.message.receive_v1 事件{'\n'}
    5. Encrypt Key 字段保持为空 — 长连接模式不使用负载加密
  </>} footer={<><button type="button" style={outlineSm}>取消</button><button type="button" style={outlineSm}>保存</button></>}>
    <div style={{ display: 'grid', gap: 11.25 }}>
      <div>
        <div style={{ marginBottom: 5.625, color: muted, fontSize: 11.25 }}>区域</div>
        <div style={{ display: 'flex', gap: 7.5 }}>
          <button type="button" style={solidSm}>Lark（国际版）</button>
          <button type="button" style={outlineSm}>飞书（中国）</button>
        </div>
      </div>
      <div>
        <div style={{ marginBottom: 5.625, color: muted, fontSize: 11.25 }}>App ID</div>
        <SecretField placeholder="cli_xxxxxxxxxxxx" value="cli_a4f8e21c3e2d0b01" />
      </div>
      <div>
        <div style={{ marginBottom: 5.625, color: muted, fontSize: 11.25 }}>App Secret</div>
        <SecretField placeholder="开发者后台提供的 32 位密钥" value="fixture-secret-9f2d4a17c6e8b3d0" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7.5 }}>
        <button type="button" style={outlineSm}>测试连接</button>
        <StatusChip ok><Check size={13.125} />凭证已接受</StatusChip>
      </div>
    </div>
  </DialogFrame>
}

// PairingCodeDialog.tsx — telegram platform. The 6-digit code, countdown and
// bot link are IPC-powered; the displayed 04:32 expiry is a frozen snapshot
// of the running countdown (the source recomputes it every second).
export function SourcePairingCode() {
  const pairCommand = '/pair 284731'
  return <DialogFrame route="pairing-code" maxWidth={440} title="配对消息通道" description="将此代码发送给您的 Telegram 机器人以连接此会话。">
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 15, padding: '15px 0' }}>
      <div style={{ padding: '15px 22.5px', borderRadius: 7.5, background: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 700, letterSpacing: '0.3em' }}>284731</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, fontSize: 13.125 }}>
        <code style={{ padding: '3.75px 7.5px', borderRadius: 3.75, background: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 13.125 }}>{pairCommand}</code>
        <button type="button" title="复制" style={{ display: 'inline-flex', alignItems: 'center', gap: 3.75, padding: '3.75px 7.5px', border: 0, borderRadius: 3.75, background: 'none', color: 'var(--foreground)', fontSize: 11.25, cursor: 'pointer' }}><Copy size={13.125} /></button>
      </div>
      <p style={{ margin: 0, textAlign: 'center', color: muted, fontSize: 13.125 }}>打开您的机器人并发送上述命令。</p>
      <a href="https://t.me/polo_official_bot" target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3.75, color: 'var(--accent)', fontSize: 13.125, textDecoration: 'underline', textUnderlineOffset: 3 }}><ExternalLink size={13.125} />t.me/polo_official_bot</a>
      <p style={{ margin: 0, color: muted, fontSize: 11.25 }}>代码过期时间 (04:32)</p>
    </div>
  </DialogFrame>
}

export function SourceSupergroupPairing() {
  const pairCommand = '/pair 592640'
  return <DialogFrame route="supergroup-pairing" title="配对 Telegram 超级群组" description="将机器人添加到你的超级群组，然后在任意话题中输入该命令。机器人需要禁用隐私模式（BotFather → /setprivacy → Disable）或拥有管理员权限才能读取非命令消息。">
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 15, padding: '15px 0' }}>
      <div style={{ padding: '15px 22.5px', borderRadius: 7.5, background: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 700, letterSpacing: '0.3em' }}>592640</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7.5, fontSize: 13.125 }}>
        <code style={{ padding: '3.75px 7.5px', borderRadius: 3.75, background: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 13.125 }}>{pairCommand}</code>
        <button type="button" title="复制" style={{ display: 'inline-flex', alignItems: 'center', gap: 3.75, padding: '3.75px 7.5px', border: 0, borderRadius: 3.75, background: 'none', color: 'var(--foreground)', fontSize: 11.25, cursor: 'pointer' }}><Copy size={13.125} /></button>
      </div>
      <p style={{ margin: 0, textAlign: 'center', color: muted, fontSize: 13.125 }}>在你的超级群组的任意话题中发送此命令。配对完成后对话框会自动关闭。</p>
      <a href="https://t.me/polo_official_bot" target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3.75, color: 'var(--accent)', fontSize: 13.125, textDecoration: 'underline', textUnderlineOffset: 3 }}><ExternalLink size={13.125} />@polo_official_bot</a>
      <p style={{ margin: 0, textAlign: 'center', color: muted, fontSize: 11.25 }}>代码将在 02:17 后过期</p>
    </div>
  </DialogFrame>
}