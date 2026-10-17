/**
 * Phone Link — 手机 ↔ Mac 配对（PRD v1.6 §⑤）
 *
 * Renderer 侧契约与纯逻辑，供三处共用：
 * - main/handlers/phone-link.ts（RPC 处理器，转发 admin devices 端点）
 * - preload/phone-link.ts（buildPhoneLinkPreloadApi）
 * - renderer/pages/settings/PhoneConnectionSettingsPage.tsx（面板）
 *
 * 本文件与 apps/electron/src/shared/types.ts 保持独立（POL-12 并行避让）：
 * ElectronAPI 不在此扩展，renderer 通过 getPhoneLinkApi() 收窄访问。
 *
 * 契约事实源：
 * - polo-admin /api/devices/pairing-code|list|revoke（POL-10 交付）
 * - 二维码 payload = JSON {"code":"8F3K2Q","wsUrl":"ws://192.168.1.20:9100"}；
 *   wsUrl 仅为 LAN 连接提示、非授权依据；拿不到 LAN 地址时只放 code。
 * - 配对码 5min TTL、一次性；重签发作废旧码。
 * - 解绑即时受理，最长 60s 全网断开。
 * - 绑定上限：每台 Mac ≤ 5 台手机（D6）。
 */

import type { AdminDeviceView } from '@polo-ai/shared/admin'
import { RPC_CHANNELS, type ElectronAPI } from './types'

/** admin 端配对码 TTL（秒）；展示与兜底倒计时都用它 */
export const PHONE_PAIRING_TTL_SECONDS = 300

/** 每台 Mac 可绑定手机上限（PRD v1.6 §⑧ D6） */
export const MAX_PHONES_PER_MAC = 5

/** 解绑语义提示（P12）：受理即时、全网断开最长 60s */
export const PHONE_REVOKE_GRACE_SECONDS = 60

/** 本卡消费的 RPC 通道（LOCAL_ONLY，见 packages/shared/src/protocol/routing.ts） */
export const PHONE_LINK_CHANNELS = {
  CREATE_PAIRING_CODE: RPC_CHANNELS.admin.CREATE_PAIRING_CODE,
  LIST_DEVICES: RPC_CHANNELS.admin.LIST_DEVICES,
  REVOKE_DEVICE: RPC_CHANNELS.admin.REVOKE_DEVICE,
  HOST_INFO: RPC_CHANNELS.phoneLink.HOST_INFO,
} as const

// ---------------------------------------------------------------------------
// Wire DTOs（跨 preload/renderer）
// ---------------------------------------------------------------------------

/** pairing-code RPC 结果：expiresInSeconds 已折算为接收端绝对过期时间 */
export interface PhonePairingCodeResult {
  code: string
  macDeviceId: string
  /** 绝对过期时间（接收端 clock，ms epoch） */
  expiresAt: number
}

export type PhoneDeviceView = AdminDeviceView

export interface PhoneDeviceListResult {
  devices: PhoneDeviceView[]
}

export interface PhoneDeviceRevokeResult {
  revokedCount: number
  devices: PhoneDeviceView[]
}

/** 面板基础信息（本机侧，非 admin）：macDeviceId + 可用时的 LAN wsUrl 提示 */
export interface PhoneLinkHostInfo {
  macDeviceId: string
  /** 本机内嵌服务器 LAN 地址（ws://…）；服务器模式未启用时为 null */
  wsUrl: string | null
}

/** M1-5/POL-12 relay 链路状态（types.ts RelayLinkStatus 的本文件投影，避免直接依赖并行卡类型） */
export type PhoneLinkRelayStatus = 'online-relay' | 'online-lan' | 'offline'

/** renderer 暴露面（preload buildPhoneLinkPreloadApi 的返回契约） */
export interface PhoneLinkPreloadApi {
  phoneDeviceCreatePairingCode(): Promise<PhonePairingCodeResult>
  phoneDeviceList(): Promise<PhoneDeviceListResult>
  phoneDeviceRevoke(deviceId: string): Promise<PhoneDeviceRevokeResult>
  phoneLinkGetHostInfo(): Promise<PhoneLinkHostInfo>
  /** 订阅 relay 链路状态广播（POL-12 relay:statusChanged）；返回退订函数 */
  phoneLinkOnRelayStatus(callback: (payload: { status: PhoneLinkRelayStatus }) => void): () => void
}

/**
 * 从 window.electronAPI 取手机连接 API。
 * ElectronAPI 类型在 types.ts（POL-12 并行避让不改动），这里做一次收窄断言；
 * preload 未注入（旧包）时方法缺失，调用方以运行时可选链兜底。
 */
export function getPhoneLinkApi(): PhoneLinkPreloadApi {
  return window.electronAPI as unknown as ElectronAPI & PhoneLinkPreloadApi
}

// ---------------------------------------------------------------------------
// 纯逻辑（bun test 覆盖）
// ---------------------------------------------------------------------------

/** pairing-code 响应 → 面板用绝对过期时间（接收即计时，秒取整上偏差 ≤1s） */
export function toPairingCodeResult(
  response: { code: string; macDeviceId: string; expiresInSeconds: number },
  nowMs: number,
): PhonePairingCodeResult {
  return {
    code: response.code,
    macDeviceId: response.macDeviceId,
    expiresAt: nowMs + response.expiresInSeconds * 1000,
  }
}

/** PRD §⑤ 二维码 payload：JSON {code, wsUrl?}；wsUrl 仅在拿到 LAN 地址时携带 */
export function buildPairingQrPayload(code: string, wsUrl?: string | null): string {
  const payload: { code: string; wsUrl?: string } = { code }
  if (wsUrl) payload.wsUrl = wsUrl
  return JSON.stringify(payload)
}

export type PairingCountdownState =
  | { kind: 'expired' }
  | { kind: 'active'; remainingMs: number }
  | { kind: 'invalid' }

/** 倒计时状态映射：≤0 即过期（过期后 UI 停在 expired，不出现负数） */
export function pairingCountdownState(expiresAt: number, nowMs: number): PairingCountdownState {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return { kind: 'invalid' }
  const remainingMs = expiresAt - nowMs
  if (remainingMs <= 0) return { kind: 'expired' }
  return { kind: 'active', remainingMs }
}

/** D02 帧「配对码 4:38 后过期」的 m:ss 文案数字部分 */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export interface PhoneDeviceListState {
  devices: PhoneDeviceView[]
  /** 活跃绑定数（revoked 行不计） */
  count: number
  /** 是否已达 5 台上限（达限后新手机 bind 会被 admin 拒绝） */
  atCapacity: boolean
}

/** 列表状态映射：过滤 revoked 行（admin list 只回活跃行，防御性双保险）、排序、容量标记 */
export function mapDeviceListState(
  devices: PhoneDeviceView[] | null | undefined,
): PhoneDeviceListState {
  const active = (devices ?? [])
    .filter(d => !d.revoked)
    .sort((a, b) => {
      const at = a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0
      const bt = b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0
      return bt - at
    })
  return {
    devices: active,
    count: active.length,
    atCapacity: active.length >= MAX_PHONES_PER_MAC,
  }
}

export type LastSeenBucket =
  | { key: 'justNow' }
  | { key: 'minutesAgo'; count: number }
  | { key: 'hoursAgo'; count: number }
  | { key: 'daysAgo'; count: number }
  | { key: 'never' }

/** 最近活跃分桶（renderer 再用 i18n 渲染文案） */
export function lastSeenBucket(lastSeenAt: string | null | undefined, nowMs: number): LastSeenBucket {
  if (!lastSeenAt) return { key: 'never' }
  const at = Date.parse(lastSeenAt)
  if (!Number.isFinite(at)) return { key: 'never' }
  const elapsedMs = nowMs - at
  if (elapsedMs < 60_000) return { key: 'justNow' }
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 60) return { key: 'minutesAgo', count: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { key: 'hoursAgo', count: hours }
  return { key: 'daysAgo', count: Math.floor(hours / 24) }
}

/**
 * 内嵌服务器 LAN wsUrl（wsUrl 仅 LAN 提示，非授权依据）。
 * 服务器模式（绑定 0.0.0.0 固定端口）未启用时返回 null —— QR 只放 code。
 */
export function buildLanWsUrl(input: {
  serverEnabled: boolean
  port: number
  tls: boolean
  lanIpv4: string | null
}): string | null {
  if (!input.serverEnabled || !input.lanIpv4) return null
  const scheme = input.tls ? 'wss' : 'ws'
  return `${scheme}://${input.lanIpv4}:${input.port}`
}

/** 首个非内部 IPv4（与 main/index.ts GET_SERVER_STATUS 的 LAN 探测同规则） */
export function firstLanIpv4(
  interfaces: Array<{ family: string; internal: boolean; address: string }>,
): string | null {
  for (const net of interfaces) {
    if (net.family === 'IPv4' && !net.internal) return net.address
  }
  return null
}

/**
 * 本机 macDeviceId 格式化（M1-5 设备注册落地前的稳定本机标识）：
 * `mac-` + sha256 摘要前 16 位十六进制，满足 admin macDeviceIdSchema
 * （6-128 字符，^[A-Za-z0-9][A-Za-z0-9._:-]*$）。摘要由主进程计算
 * （hostname+homeDir），M1-5 接入后由注册结果替换。
 */
export function formatLocalMacDeviceId(digestHex: string): string {
  return `mac-${digestHex.replace(/[^0-9a-f]/gi, '').slice(0, 16)}`
}
