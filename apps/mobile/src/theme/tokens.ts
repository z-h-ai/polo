// Design tokens for the mobile app (POL-14).
//
// Approximations of the prototype CSS variables (polo-mobile-prototype.html,
// design tokens sourced from polo-client-design SOT / electron_renderer light).
// Centralized here so screens never hardcode raw colors.

export const colors = {
  background: '#f7f8fa', // --background
  foreground: '#111317', // --foreground
  accent: '#8a75cd', // --accent
  accentDeep: '#53497a', // logo gradient end (prototype inline value)
  accentSoft: 'rgba(138,117,205,0.09)', // tinted backgrounds
  accentSoftSolid: '#eae8f5', // .avatar.acc tint pre-flattened over --background (opaque, maskable)
  destructive: '#e6000c', // --destructive
  destructiveBg: 'rgba(230,0,12,0.08)', // errbar background
  destructiveBorder: 'rgba(230,0,12,0.2)', // errbar border
  dangerBg: 'rgba(230,0,12,0.1)', // .btnD background (不是我，拒绝)
  dangerBorder: 'rgba(230,0,12,0.25)', // .btnD border
  warning: '#8c5f27', // .infobar copy (anti-phishing hint)
  warningBg: 'rgba(237,153,14,0.1)', // .infobar background
  warningBorder: 'rgba(237,153,14,0.25)', // .infobar border
  fieldBorder: 'rgba(17,19,23,0.15)', // neutral default input border (P03)
  success: '#098926', // --success
  info: '#ed990e', // --info
  fieldBg: '#f0f1f4', // --fg-3 (input background)
  border: 'rgba(17,19,23,0.05)', // --border
  buttonBorder: 'rgba(17,19,23,0.15)', // .dbtn.o border
  fg40: '#9b9ca0', // placeholder (.field.ph)
  fg50: '#848589', // --fg-50 (muted)
  fg60: '#6d6e72', // --fg-60 (field labels)
  white: '#ffffff',
} as const;

export const radius = {
  field: 12, // .field border-radius
  toast: 12, // .toast border-radius
  errorBar: 10, // .errbar border-radius
  logo: 17, // logo squircle (56px box)
} as const;

export const fontSize = {
  fieldLabel: 11.25, // 手机号 / 验证码 label
  hint: 11.25, // 验证码 5 分钟内有效 · ...
  agreement: 11, // 继续即表示同意 ...
  toast: 12, // 发码成功 toast
  error: 12.5, // .errbar 文案
  body: 15, // input text
  button: 14, // .btnP
  action: 12.5, // .dbtn（获取验证码/重发）
  title: 20, // Polo
  subtitle: 13, // 验证手机号即可登录或注册
} as const;

export const spacing = {
  screenX: 28, // .pbody padding
  fieldGap: 15, // form vertical gap
  labelGap: 7.5, // label -> field
} as const;
