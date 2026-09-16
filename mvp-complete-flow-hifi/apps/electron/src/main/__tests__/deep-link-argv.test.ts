import { describe, expect, it } from 'bun:test'
import { findDeepLinkArgument } from '../deep-link-argv'

describe('deep-link argv discovery', () => {
  it('finds a join link delivered to the first Windows/Linux process', () => {
    const joinUrl = 'poloai://join/cold-start-token-abcdefghijklmnopqrstuvwxyz'
    expect(findDeepLinkArgument([
      '/opt/Polo AI/polo-ai',
      '/opt/Polo AI/resources/app.asar',
      '--some-electron-flag',
      joinUrl,
    ])).toBe(joinUrl)
  })

  it('finds a join link delivered through a second-instance command line', () => {
    const joinUrl = 'poloai2://join/second-instance-token-abcdefghijklmnopqrstuvwxyz'
    expect(findDeepLinkArgument([
      'C:\\Program Files\\Polo AI\\Polo AI.exe',
      '--allow-file-access-from-files',
      joinUrl,
    ], 'poloai2')).toBe(joinUrl)
  })

  it('ignores unrelated arguments and unsupported protocols', () => {
    expect(findDeepLinkArgument([
      '/Applications/Polo AI.app/Contents/MacOS/Polo AI',
      '--inspect=9229',
      'https://example.com',
    ])).toBeNull()
  })
})
