import { Eye } from 'lucide-react'

// Exact visual branch from AdminLoginStep.tsx when phoneAuthEnabled is false.
export function SourceAdminLogin() {
  return <div className="source-admin-login"><div className="source-admin-login__titlebar"/><main><section className="source-admin-login__card" aria-label="Admin 登录"><div className="source-admin-login__identity"><div className="source-admin-login__mark"><PoloAiSymbol/></div><h1>Polo AI</h1><p>请输入你的账号和密码</p></div><form><label htmlFor="admin-identifier">手机号或用户名</label><input id="admin-identifier" autoComplete="username" placeholder="请输入手机号或用户名"/><label htmlFor="admin-password">密码</label><div className="source-admin-login__password"><input id="admin-password" type="password" autoComplete="current-password" placeholder="请输入密码"/><button type="button" aria-label="显示密码"><Eye size={16}/></button></div><button type="submit" disabled>登录</button></form></section></main></div>
}
function PoloAiSymbol(){return <svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><path d="M 22 85 V 10 H 44 A 19 19 0 0 1 44 48 H 34" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="42" cy="76" r="9" fill="currentColor"/><path d="M 60 65 V 85 H 68" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="84" cy="76" r="9" fill="currentColor"/></svg>}
