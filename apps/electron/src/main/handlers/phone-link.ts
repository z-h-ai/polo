/**
 * Phone Link handlers — 手机 ↔ Mac 配对（PRD v1.6 §⑤，POL-13）
 *
 * 三个 LOCAL_ONLY RPC 通道，把 renderer 的设置页请求转发到 polo-admin
 * devices 端点（AdminClient 模式同 handlers/local-apps.ts：本地凭据 + getAdminUrl）：
 * - admin:createPairingCode → POST /api/devices/pairing-code（5min TTL、一次性）
 * - admin:listDevices       → GET  /api/devices/list（绑定事实源：admin Device 表）
 * - admin:revokeDevice      → POST /api/devices/revoke（解绑即时受理，最长 60s 断开）
 *
 * 另有 phoneLink:hostInfo：本机 macDeviceId 与内嵌服务器 LAN wsUrl
 * （二维码 payload 的连接提示，非授权依据）。
 *
 * macDeviceId 说明：M1-5 设备注册尚未落地，先用 hostname+homeDir 的 sha256
 * 派生稳定本机标识（formatLocalMacDeviceId）；M1-5 接入后只需替换
 * getLocalMacDeviceId() 一处。
 *
 * 注意：admin 契约字段以 polo-admin main@deb31d86 为准（POL-10）。
 */

import { createHash } from 'crypto'
import { hostname, homedir, networkInterfaces } from 'os'
import { AdminClient } from '@polo-ai/shared/admin'
import { getAdminUrl } from '@polo-ai/shared/config'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import { getServerConfig } from '@polo-ai/shared/config'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from './handler-deps'
import {
  buildLanWsUrl,
  firstLanIpv4,
  formatLocalMacDeviceId,
  toPairingCodeResult,
  PHONE_LINK_CHANNELS,
  type PhoneLinkHostInfo,
} from '../../shared/phone-link'

/** 本卡在 GUI 处理器注册的全部通道（handlers/index.ts 防重复注册用） */
export const PHONE_LINK_HANDLED_CHANNELS = [
  PHONE_LINK_CHANNELS.CREATE_PAIRING_CODE,
  PHONE_LINK_CHANNELS.LIST_DEVICES,
  PHONE_LINK_CHANNELS.REVOKE_DEVICE,
  PHONE_LINK_CHANNELS.HOST_INFO,
] as const

/** 未登录 admin（无本地凭据）时的统一失败 */
class PhoneLinkUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhoneLinkUnavailableError'
  }
}

async function requireAdminClient(): Promise<{ client: AdminClient; accessToken: string }> {
  const adminUrl = getAdminUrl()
  const tokens = await getCredentialManager().getAdminTokens()
  if (!adminUrl || !tokens?.accessToken) {
    throw new PhoneLinkUnavailableError('Admin session is not available')
  }
  return { client: new AdminClient(adminUrl), accessToken: tokens.accessToken }
}

/**
 * 本机稳定 macDeviceId（M1-5 前的派生实现，收口在此一处）
 *
 * 派生：sha256(`${hostname()}\0${homedir()}`)，\0 分隔避免两端拼接歧义；
 * 同机跨启动稳定（hostname/homeDir 不变即不变）。
 *
 * 冲突风险（M1-5 替换前已知）：仅对「同 hostname + 同 homeDir」的机器碰撞——
 * 典型场景是同一账号的两台同型号 Mac 均用默认主机名。碰撞时 admin 侧
 * (userId, macDeviceId) 复合唯一键会把两台 Mac 视作同一绑定行（后绑覆盖先绑）。
 * 该风险随 M1-5 以服务端注册结果（relay 命名空间的设备 ID）替换本实现而消除；
 * 传输面（relay/服务器）不消费本值做授权，仅作配对码归属标记。
 */
export function getLocalMacDeviceId(): string {
  const digest = createHash('sha256').update(`${hostname()}\u0000${homedir()}`).digest('hex')
  return formatLocalMacDeviceId(digest)
}

/** 内嵌服务器 LAN ws 地址；服务器模式未启用/拿不到 LAN IPv4 时为 null */
export function getPhoneLinkHostInfo(): PhoneLinkHostInfo {
  const serverConfig = getServerConfig()
  const lanIpv4 = firstLanIpv4(
    Object.values(networkInterfaces()).flat().filter(Boolean) as Array<{
      family: string
      internal: boolean
      address: string
    }>,
  )
  return {
    macDeviceId: getLocalMacDeviceId(),
    wsUrl: buildLanWsUrl({
      serverEnabled: serverConfig.enabled,
      port: serverConfig.port,
      tls: !!serverConfig.tlsCertPath,
      lanIpv4,
    }),
  }
}

export function registerPhoneLinkHandlers(server: RpcServer, _deps: HandlerDeps): void {
  // 签发配对码：重签发作废旧码由 admin 端保证；这里把相对 TTL 折算为绝对过期时间
  server.handle(PHONE_LINK_CHANNELS.CREATE_PAIRING_CODE, async () => {
    const { client, accessToken } = await requireAdminClient()
    const issued = await client.createDevicePairingCode(accessToken, {
      macDeviceId: getLocalMacDeviceId(),
    })
    return toPairingCodeResult(issued, Date.now())
  })

  server.handle(PHONE_LINK_CHANNELS.LIST_DEVICES, async () => {
    const { client, accessToken } = await requireAdminClient()
    return client.listDevices(accessToken)
  })

  server.handle(PHONE_LINK_CHANNELS.REVOKE_DEVICE, async (_ctx, deviceId: string) => {
    if (typeof deviceId !== 'string' || !deviceId) {
      throw new PhoneLinkUnavailableError('deviceId is required')
    }
    const { client, accessToken } = await requireAdminClient()
    return client.revokeDevice(accessToken, { deviceId })
  })

  server.handle(PHONE_LINK_CHANNELS.HOST_INFO, async () => getPhoneLinkHostInfo())
}
