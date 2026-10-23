import { afterEach, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { i18n, setupI18n, SUPPORTED_LANGUAGE_CODES } from '@polo-ai/shared/i18n'
import { I18nextProvider } from 'react-i18next'
GlobalRegistrator.register()
await setupI18n()
const { AdminKickedStep } = await import('../AdminKickedStep')
const { render, screen, cleanup, act, fireEvent } = await import('@testing-library/react')
afterEach(cleanup)
it('R7 token_revoked without reason evidence shows neutral recovery in all locales', async () => {
  const titles = { en: 'Your session has ended', 'zh-Hans': '登录状态已失效', es: 'Tu sesión ha finalizado', ja: 'ログイン状態が無効になりました', hu: 'A munkamenet véget ért', de: 'Deine Sitzung ist abgelaufen', pl: 'Twoja sesja wygasła' }
  let relogins = 0
  render(createElement(I18nextProvider, { i18n, children: createElement(AdminKickedStep, { onRelogin: () => { relogins++ } }) }))
  for (const language of SUPPORTED_LANGUAGE_CODES) {
    await act(async () => { await i18n.changeLanguage(language) })
    expect(screen.getByRole('heading').textContent).toBe(titles[language])
  }
  fireEvent.click(screen.getByRole('button'))
  expect(relogins).toBe(1)
})
