import React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import LoginPage, {
  createElectronLoginAdapter,
  getLoginErrorMessage,
  type LoginPageProps,
} from '../LoginPage'

function renderLoginPage(props: Partial<LoginPageProps> = {}) {
  return renderToStaticMarkup(
    <LoginPage
      login={async () => ({ user: { id: 'u1', username: 'alice', role: 'admin' } })}
      fetchPostLoginConfig={async () => ({ wsUrl: 'ws://localhost' })}
      onSuccess={() => {}}
      onConfigError={() => {}}
      {...props}
    />,
  )
}

describe('LoginPage', () => {
  it('renders username input, password input, and submit button', () => {
    const html = renderLoginPage()

    expect(html).toContain('name="username"')
    expect(html).toContain('name="password"')
    expect(html).toContain('type="password"')
    expect(html).toContain('type="submit"')
  })

  it('maps all auth error variants to user-readable Chinese messages', () => {
    expect(getLoginErrorMessage({ code: 'invalid_credentials' })).toBe('用户名或密码错误')
    expect(getLoginErrorMessage({ code: 'account_disabled' })).toBe('账号已被禁用，请联系管理员')
    expect(getLoginErrorMessage({ code: 'rate_limited', retryAfterSeconds: 30 })).toBe('请 30 秒后再试')
    expect(getLoginErrorMessage({ code: 'network_error' })).toBe('无法连接服务器，请检查网络连接')
  })

  it('uses Electron IPC auth adapter instead of AdminApiClient directly', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const adapter = createElectronLoginAdapter({
      invokeAuth: async (channel, ...args) => {
        calls.push({ channel, args })
        return { user: { id: 'u1', username: 'zhangsan', role: 'admin' } }
      },
    })

    const result = await adapter('zhangsan', 'pass')

    expect(calls).toEqual([{ channel: 'auth:login', args: ['zhangsan', 'pass'] }])
    expect(result).toEqual({ user: { id: 'u1', username: 'zhangsan', role: 'admin' } })
    expect('token' in result).toBe(false)
  })
})
