import { describe, expect, it, mock } from 'bun:test'
import { BrowserActionAuthorization, browserActionDigest, type BrowserActionFacts, type BrowserActionScope } from '../browser-action-authorization'
import { defaultBrowserPolicy } from '../../admin/browser-policy-contract'

function setup(name: string, formText = '', href = '') {
  const scope: BrowserActionScope = { accountId: 'a', productSpaceId: '11111111-1111-4111-8111-111111111111', sessionId: 's', generation: 1 }
  const facts: BrowserActionFacts = { browserId: 'browser1', documentId: 'guide:loader1', url: 'https://example.test/guide', frameUrl: 'https://example.test/guide', connected: true, tag: 'body', role: '', name, href, inputType: '', formText, fields: {}, hasInlineMutation: false }
  const policy = { productSpaceId: scope.productSpaceId, configVersion: '1', policy: defaultBrowserPolicy(), policyDigest: '' }
  const confirm = mock(() => {})
  const dispatch = mock(async () => 'navigated')
  const authorization = new BrowserActionAuthorization({ scope: () => scope, assertCurrent: () => {}, facts: async () => facts, policy: async () => { policy.policyDigest = browserActionDigest(policy.policy); return policy }, userMessages: () => [{ id: 'human', text: '打开帮助页面' }], confirm })
  return { authorization, policy, dispatch, confirm }
}

describe('navigate uses its destination, not unrelated current-page text', () => {
  for (const [name, form, href] of [
    ['未提交输入', '', ''],
    ['支付订单', '提交支付表单', ''],
    ['确认', '', 'https://example.test/checkout'],
    ['publish controls on this page', '', ''],
  ]) it('allows safe navigation despite current focused/body text: ' + name, async () => {
    const f = setup(name!, form!, href!)
    f.policy.policy.dangerousWords.push('publish')
    expect(await f.authorization.perform(['navigate', 'https://example.test/help'], f.dispatch)).toBe('navigated')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.confirm).not.toHaveBeenCalled()
  })
  for (const target of ['https://example.test/checkout', 'https://example.test/pay', 'https://example.test/?action=pay']) it('still rejects a consequential destination: ' + target, async () => {
    const f = setup('打开帮助')
    await expect(f.authorization.perform(['navigate', target], f.dispatch)).rejects.toThrow('consequence unclear')
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('still rejects a destination matching configured dangerousWords', async () => {
    const f = setup('普通介绍')
    f.policy.policy.dangerousWords.push('publish')
    await expect(f.authorization.perform(['navigate', 'https://example.test/publish'], f.dispatch)).rejects.toThrow('consequence unclear')
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  for (const command of [['back'], ['forward'], ['evaluate', 'window.writes++']]) it('does not relax opaque history or evaluation: ' + command[0], async () => {
    const f = setup('未提交输入', '支付表单')
    await expect(f.authorization.perform(command, f.dispatch)).rejects.toThrow('consequence unclear')
    expect(f.dispatch).not.toHaveBeenCalled()
  })
})
