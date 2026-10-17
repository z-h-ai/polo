import { describe, expect, it } from 'bun:test'
import { formatSubscriptionPrice } from '../format-subscription-price'

describe('formatSubscriptionPrice', () => {
  it('converts minor units for known currencies', () => {
    expect(formatSubscriptionPrice(29900, 'CNY', 'zh-Hans')).toContain('299.00')
    expect(formatSubscriptionPrice(29900, 'CNY', 'en')).toContain('299.00')
  })

  it('keeps zero explicit without fabricating unavailable values', () => {
    expect(formatSubscriptionPrice(0, 'CNY', 'zh-Hans')).toContain('0.00')
    expect(formatSubscriptionPrice(null, 'CNY', 'zh-Hans')).toBe('')
    expect(formatSubscriptionPrice(29900, null, 'zh-Hans')).toBe('')
    expect(formatSubscriptionPrice(29900, '', 'zh-Hans')).toBe('')
    expect(formatSubscriptionPrice(-1, 'CNY', 'zh-Hans')).toBe('')
  })

  it('falls back to the provider currency code for an Intl-unknown currency', () => {
    const formatted = formatSubscriptionPrice(29900, 'XYZ', 'zh-Hans')
    expect(formatted.startsWith('XYZ')).toBe(true)
    expect(formatted).toContain('299.00')
  })
})
