import { describe, expect, it } from 'bun:test'
import { isValidTimezoneInput } from '../timezone'

describe('isValidTimezoneInput', () => {
  it('accepts empty input (the field is optional)', () => {
    expect(isValidTimezoneInput('')).toBe(true)
    expect(isValidTimezoneInput('   ')).toBe(true)
  })

  it('accepts canonical IANA zone names', () => {
    expect(isValidTimezoneInput('Asia/Shanghai')).toBe(true)
    expect(isValidTimezoneInput('America/New_York')).toBe(true)
    expect(isValidTimezoneInput('Europe/Paris')).toBe(true)
    expect(isValidTimezoneInput('Etc/GMT+8')).toBe(true)
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isValidTimezoneInput('  asia/shanghai ')).toBe(true)
  })

  it('accepts platform-recognized aliases like UTC / GMT / PRC', () => {
    expect(isValidTimezoneInput('UTC')).toBe(true)
    expect(isValidTimezoneInput('GMT')).toBe(true)
    expect(isValidTimezoneInput('PRC')).toBe(true)
  })

  it('rejects obvious typos in well-known zones', () => {
    expect(isValidTimezoneInput('Asia/Shanghia')).toBe(false)
    expect(isValidTimezoneInput('America/New_Yrok')).toBe(false)
  })

  it('rejects free-text garbage (spaces, CJK, offsets without a zone name)', () => {
    expect(isValidTimezoneInput('上海时间')).toBe(false)
    expect(isValidTimezoneInput('GMT+8')).toBe(false)
    expect(isValidTimezoneInput('GMT 8')).toBe(false)
    expect(isValidTimezoneInput('UTC; rm -rf')).toBe(false)
  })
})
