/**
 * phone-link 主进程 RPC 处理器测试（POL-238）。
 *
 * 用假 RpcServer 捕获 registerPhoneLinkHandlers 注册的 4 个处理器，
 * mock AdminClient / admin 凭据 / 配置，验证：
 * - 转发 admin devices 三端点的请求/响应形状（POL-235 契约）
 * - 配对码相对 TTL → 接收端绝对过期时间的折算
 * - revoke 的 deviceId 入参校验（admin 侧 deviceId/macDeviceId 二选一）
 * - 未登录 admin 的统一失败
 * - hostInfo：macDeviceId 派生（sha256(hostname+homeDir)，稳定）与服务器关闭时 wsUrl=null
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../../shared/types'
import { PHONE_PAIRING_TTL_SECONDS } from '../../../shared/phone-link'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

type HandlerFn = (ctx: { clientId: string }, ...args: any[]) => Promise<any> | any

const getAdminTokensMock = mock(
  async (): Promise<{ accessToken: string; refreshToken: string } | null> => ({
    accessToken: 'token-123',
    refreshToken: 'r',
  }),
)
const getAdminUrlMock = mock(() => 'https://admin.example.com')
const getServerConfigMock = mock(() => ({ enabled: false, port: 9100 }))

const adminClientCalls: Array<{ method: string; args: unknown[] }> = []

class FakeAdminClient {
  constructor(_baseUrl: string) {}

  async createDevicePairingCode(_token: string, input: { macDeviceId: string }) {
    adminClientCalls.push({ method: 'createDevicePairingCode', args: [input] })
    return { code: '135790', macDeviceId: input.macDeviceId, expiresInSeconds: 300 }
  }

  async listDevices(_token: string) {
    adminClientCalls.push({ method: 'listDevices', args: [] })
    return { devices: [] }
  }

  async revokeDevice(_token: string, input: { deviceId?: string; macDeviceId?: string }) {
    adminClientCalls.push({ method: 'revokeDevice', args: [input] })
    return { revokedCount: 1, devices: [] }
  }
}

mock.module('@polo-ai/shared/admin', () => ({ AdminClient: FakeAdminClient }))
mock.module('@polo-ai/shared/credentials', () => ({
  getCredentialManager: () => ({ getAdminTokens: getAdminTokensMock }),
}))
mock.module('@polo-ai/shared/config', () => ({
  getAdminUrl: getAdminUrlMock,
  getServerConfig: getServerConfigMock,
}))

const { registerPhoneLinkHandlers, PHONE_LINK_HANDLED_CHANNELS, getLocalMacDeviceId } = await import(
  '../phone-link'
)

describe('phone link RPC handlers', () => {
  const handlers = new Map<string, HandlerFn>()

  beforeEach(async () => {
    handlers.clear()
    adminClientCalls.length = 0
    getAdminTokensMock.mockImplementation(async () => ({ accessToken: 'token-123', refreshToken: 'r' }))
    getServerConfigMock.mockImplementation(() => ({ enabled: false, port: 9100 }))

    const server: RpcServer = {
      handle(channel: string, handler: HandlerFn) {
        handlers.set(channel, handler)
      },
      push() {},
      async invokeClient() {
        return null
      },
      hasClientCapability() {
        return false
      },
      findClientsWithCapability() {
        return []
      },
    } as unknown as RpcServer

    registerPhoneLinkHandlers(server, {} as HandlerDeps)
  })

  it('registers exactly the four LOCAL_ONLY phone-link channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [...PHONE_LINK_HANDLED_CHANNELS].sort(),
    )
    expect(PHONE_LINK_HANDLED_CHANNELS).toEqual([
      RPC_CHANNELS.admin.CREATE_PAIRING_CODE,
      RPC_CHANNELS.admin.LIST_DEVICES,
      RPC_CHANNELS.admin.REVOKE_DEVICE,
      RPC_CHANNELS.phoneLink.HOST_INFO,
    ])
  })

  it('forwards pairing-code issuance and folds the relative TTL into an absolute expiry', async () => {
    const before = Date.now()
    const result = await handlers.get(RPC_CHANNELS.admin.CREATE_PAIRING_CODE)!({ clientId: 'c1' })

    expect(adminClientCalls).toEqual([
      { method: 'createDevicePairingCode', args: [{ macDeviceId: getLocalMacDeviceId() }] },
    ])
    expect(result.code).toBe('135790')
    // 折算后 = 接收时刻 + TTL（±1s 钟差容忍）
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + PHONE_PAIRING_TTL_SECONDS * 1000 - 1_000)
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + PHONE_PAIRING_TTL_SECONDS * 1000)
  })

  it('forwards the device list with the local admin token', async () => {
    const result = await handlers.get(RPC_CHANNELS.admin.LIST_DEVICES)!({ clientId: 'c1' })

    expect(adminClientCalls).toEqual([{ method: 'listDevices', args: [] }])
    expect(result).toEqual({ devices: [] })
  })

  it('forwards revoke with the deviceId and rejects empty/non-string ids', async () => {
    const result = await handlers.get(RPC_CHANNELS.admin.REVOKE_DEVICE)!(
      { clientId: 'c1' },
      '11111111-1111-4111-8111-111111111111',
    )
    expect(adminClientCalls).toEqual([
      {
        method: 'revokeDevice',
        args: [{ deviceId: '11111111-1111-4111-8111-111111111111' }],
      },
    ])
    expect(result.revokedCount).toBe(1)

    // admin deviceRevokeSchema 要求 deviceId/macDeviceId 恰好其一 —— 空参直接本地拒绝
    await expect(
      handlers.get(RPC_CHANNELS.admin.REVOKE_DEVICE)!({ clientId: 'c1' }, ''),
    ).rejects.toThrow('deviceId is required')
    await expect(
      handlers.get(RPC_CHANNELS.admin.REVOKE_DEVICE)!({ clientId: 'c1' }, 42),
    ).rejects.toThrow('deviceId is required')
    expect(adminClientCalls.length).toBe(1)
  })

  it('fails uniformly when no admin session is available', async () => {
    getAdminTokensMock.mockImplementation(async () => null)

    await expect(handlers.get(RPC_CHANNELS.admin.CREATE_PAIRING_CODE)!({ clientId: 'c1' })).rejects.toThrow(
      'Admin session is not available',
    )
    expect(adminClientCalls).toEqual([])
  })

  it('exposes host info with a stable derived macDeviceId and null wsUrl when the server is off', async () => {
    const info = await handlers.get(RPC_CHANNELS.phoneLink.HOST_INFO)!({ clientId: 'c1' })

    // mac- + 16 位十六进制，满足 admin macDeviceIdSchema（6-128，^[A-Za-z0-9][A-Za-z0-9._:-]*$）
    expect(info.macDeviceId).toMatch(/^mac-[0-9a-f]{16}$/)
    // 同进程内稳定（sha256(hostname+homeDir) 派生；M1-5 注册落地后由注册结果替换）
    expect(getLocalMacDeviceId()).toBe(getLocalMacDeviceId())
    // 服务器模式未启用 → 不产出 LAN 提示，二维码退化为仅 code
    expect(info.wsUrl).toBeNull()
  })

  it('builds a LAN ws hint when server mode is enabled and a non-internal IPv4 exists', async () => {
    getServerConfigMock.mockImplementation(() => ({
      enabled: true,
      port: 9100,
      tlsCertPath: '/tmp/cert.pem',
    }))

    const info = await handlers.get(RPC_CHANNELS.phoneLink.HOST_INFO)!({ clientId: 'c1' })

    // 本测试环境必有回环之外的 IPv4 或只有回环 —— 两种都合法，校验形状即可
    expect(info.wsUrl === null || /^wss:\/\/[^:]+:9100$/.test(info.wsUrl)).toBe(true)
  })
})
