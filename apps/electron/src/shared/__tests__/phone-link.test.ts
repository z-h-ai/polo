import { describe, it, expect } from 'bun:test'
import {
  buildPairingQrPayload,
  pairingCountdownState,
  formatCountdown,
  toPairingCodeResult,
  mapDeviceListState,
  lastSeenBucket,
  buildLanWsUrl,
  firstLanIpv4,
  formatLocalMacDeviceId,
  PHONE_PAIRING_TTL_SECONDS,
  MAX_PHONES_PER_MAC,
} from '../phone-link'

const MIN = 60_000

describe('toPairingCodeResult', () => {
  it('folds the relative TTL into an absolute expiry on the receiving clock', () => {
    const now = 1_700_000_000_000
    const result = toPairingCodeResult(
      { code: '8F3K2Q', macDeviceId: 'mac-abcd1234', expiresInSeconds: 300 },
      now,
    )
    expect(result.expiresAt).toBe(now + 300_000)
    expect(result.code).toBe('8F3K2Q')
  })
})

describe('buildPairingQrPayload (PRD v1.6 §⑤)', () => {
  it('embeds code and wsUrl as JSON', () => {
    expect(buildPairingQrPayload('8F3K2Q', 'ws://192.168.1.20:9100')).toBe(
      JSON.stringify({ code: '8F3K2Q', wsUrl: 'ws://192.168.1.20:9100' }),
    )
  })

  it('omits wsUrl when the LAN address is unavailable — payload stays code-only', () => {
    expect(buildPairingQrPayload('8F3K2Q', null)).toBe(JSON.stringify({ code: '8F3K2Q' }))
    expect(buildPairingQrPayload('8F3K2Q', undefined)).toBe(JSON.stringify({ code: '8F3K2Q' }))
    expect(buildPairingQrPayload('8F3K2Q', '')).toBe(JSON.stringify({ code: '8F3K2Q' }))
  })
})

describe('pairingCountdownState', () => {
  const expiresAt = 1_000_000

  it('is active with positive remaining time before expiry', () => {
    const state = pairingCountdownState(expiresAt, expiresAt - 5_000)
    expect(state).toEqual({ kind: 'active', remainingMs: 5_000 })
  })

  it('flips to expired exactly at expiry and never reports negative time', () => {
    expect(pairingCountdownState(expiresAt, expiresAt)).toEqual({ kind: 'expired' })
    expect(pairingCountdownState(expiresAt, expiresAt + 60_000)).toEqual({ kind: 'expired' })
  })

  it('marks non-finite or non-positive expiries invalid', () => {
    expect(pairingCountdownState(0, 0).kind).toBe('invalid')
    expect(pairingCountdownState(Number.NaN, 0).kind).toBe('invalid')
  })
})

describe('formatCountdown (D02: 配对码 4:38 后过期)', () => {
  it('renders m:ss with zero padding', () => {
    expect(formatCountdown(4 * MIN + 38_000)).toBe('4:38')
    expect(formatCountdown(5 * MIN)).toBe('5:00')
    expect(formatCountdown(59_000)).toBe('0:59')
  })

  it('clamps to 0:00 and rounds sub-second remainders up', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-3_000)).toBe('0:00')
    expect(formatCountdown(1_000)).toBe('0:01')
    expect(formatCountdown(100)).toBe('0:01')
  })
})

describe('mapDeviceListState', () => {
  const device = (id: string, overrides: Partial<{ revoked: boolean; lastSeenAt: string }> = {}) => ({
    id,
    name: `Phone ${id}`,
    platform: 'ios' as const,
    macDeviceId: `mac-${id}`,
    pushToken: null,
    lastSeenAt: overrides.lastSeenAt ?? '2026-10-17T10:00:00.000Z',
    boundAt: '2026-10-01T00:00:00.000Z',
    revoked: overrides.revoked ?? false,
  })

  it('sorts by most recently active and counts active bindings', () => {
    const state = mapDeviceListState([
      device('a', { lastSeenAt: '2026-10-17T09:00:00.000Z' }),
      device('b', { lastSeenAt: '2026-10-17T11:00:00.000Z' }),
    ])
    expect(state.devices.map(d => d.id)).toEqual(['b', 'a'])
    expect(state.count).toBe(2)
    expect(state.atCapacity).toBe(false)
  })

  it('treats null input as an empty list', () => {
    expect(mapDeviceListState(null)).toEqual({ devices: [], count: 0, atCapacity: false })
  })

  it('flags capacity at 5 bound phones (PRD v1.6 §⑧ D6)', () => {
    const five = Array.from({ length: MAX_PHONES_PER_MAC }, (_, i) => device(String(i)))
    expect(mapDeviceListState(five).atCapacity).toBe(true)
    expect(mapDeviceListState(five.slice(0, 4)).atCapacity).toBe(false)
  })

  it('filters out revoked rows defensively (admin list returns active rows only)', () => {
    const state = mapDeviceListState([device('a'), device('b', { revoked: true })])
    expect(state.devices.map(d => d.id)).toEqual(['a'])
    expect(state.count).toBe(1)
  })

  it('keeps the admin pairing TTL constant at 5 minutes', () => {
    expect(PHONE_PAIRING_TTL_SECONDS).toBe(300)
  })
})

describe('lastSeenBucket', () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z')

  it('buckets by elapsed time', () => {
    expect(lastSeenBucket('2026-10-17T11:59:40.000Z', now)).toEqual({ key: 'justNow' })
    expect(lastSeenBucket('2026-10-17T11:40:00.000Z', now)).toEqual({ key: 'minutesAgo', count: 20 })
    expect(lastSeenBucket('2026-10-17T09:00:00.000Z', now)).toEqual({ key: 'hoursAgo', count: 3 })
    expect(lastSeenBucket('2026-10-14T12:00:00.000Z', now)).toEqual({ key: 'daysAgo', count: 3 })
  })

  it('falls back to never for missing or malformed timestamps', () => {
    expect(lastSeenBucket(null, now)).toEqual({ key: 'never' })
    expect(lastSeenBucket('not-a-date', now)).toEqual({ key: 'never' })
  })
})

describe('buildLanWsUrl', () => {
  it('builds a LAN hint URL only when server mode is enabled and an IPv4 exists', () => {
    expect(buildLanWsUrl({ serverEnabled: true, port: 9100, tls: false, lanIpv4: '192.168.1.20' })).toBe(
      'ws://192.168.1.20:9100',
    )
    expect(buildLanWsUrl({ serverEnabled: true, port: 9100, tls: true, lanIpv4: '192.168.1.20' })).toBe(
      'wss://192.168.1.20:9100',
    )
  })

  it('returns null when server mode is off or no LAN IPv4 was found — QR falls back to code-only', () => {
    expect(buildLanWsUrl({ serverEnabled: false, port: 9100, tls: false, lanIpv4: '192.168.1.20' })).toBeNull()
    expect(buildLanWsUrl({ serverEnabled: true, port: 9100, tls: false, lanIpv4: null })).toBeNull()
  })
})

describe('firstLanIpv4', () => {
  it('picks the first non-internal IPv4', () => {
    expect(firstLanIpv4([
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: true, address: '127.0.0.1' },
      { family: 'IPv4', internal: false, address: '192.168.1.20' },
    ])).toBe('192.168.1.20')
  })

  it('returns null when only loopback interfaces exist', () => {
    expect(firstLanIpv4([{ family: 'IPv4', internal: true, address: '127.0.0.1' }])).toBeNull()
  })
})

describe('formatLocalMacDeviceId (admin macDeviceIdSchema shape)', () => {
  it('produces mac- + 16 hex chars matching ^[A-Za-z0-9][A-Za-z0-9._:-]*$ (6-128)', () => {
    const id = formatLocalMacDeviceId('0123456789abcdefXYZ')
    expect(id).toBe('mac-0123456789abcdef')
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
    expect(id.length).toBeGreaterThanOrEqual(6)
    expect(id.length).toBeLessThanOrEqual(128)
  })

  it('ignores non-hex noise in the digest input', () => {
    expect(formatLocalMacDeviceId('zz')).toBe('mac-')
  })
})
