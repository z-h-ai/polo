/**
 * ASR supplier capability/config source (POL-245, card step 3).
 *
 * admin 是供应商配置事实源（默认供应商 + 速率卡，可配可切换）。admin 配置端点
 * 尚未实现（M2-3 后续接线）——本卡先以 env/本地配置读取 + 60s TTL 缓存兜底，
 * `AsrSupplierConfigSource` 就是后续 admin 下发的接线位：换实现、零调用点改动。
 * 配置变更对新连接生效、存量连接不受影响（握手时快照）。
 */

import { TtlCache } from '../auth.ts'
import type { AsrMode, AsrRateCard } from './types.ts'

export interface AsrSupplierDescriptor {
  supplier: string
  mode: AsrMode
  rateCard: AsrRateCard
}

export interface AsrSupplierConfig {
  defaultSupplier: string
  suppliers: Record<string, AsrSupplierDescriptor>
}

export interface AsrSupplierConfigSource {
  load(): AsrSupplierConfig
}

/** 加价系数 ×1.3，与 polo-admin VOICE_MARKUP_PERMILLE 同源。 */
export const ASR_MARKUP_PERMILLE = 1300

/**
 * 内置速率卡镜像 polo-admin main@c3257421 的 VOICE_RATE_CARDS（火山 STREAM
 * 4.5 元/h；MiMo FILE 单价待回填 = 不可报价）。env 覆盖优先。
 */
function builtinSupplierConfig(): Record<string, AsrSupplierDescriptor> {
  return {
    volcengine: {
      supplier: 'volcengine',
      mode: 'STREAM',
      rateCard: { pricePerHourCny: 4.5, pricePerRequestCny: null, markupPermille: ASR_MARKUP_PERMILLE, mock: false },
    },
    mimo: {
      supplier: 'mimo',
      mode: 'FILE',
      rateCard: { pricePerHourCny: null, pricePerRequestCny: null, markupPermille: ASR_MARKUP_PERMILLE, mock: false },
    },
    mock: {
      supplier: 'mock',
      mode: 'STREAM',
      rateCard: { pricePerHourCny: 4.5, pricePerRequestCny: null, markupPermille: ASR_MARKUP_PERMILLE, mock: true },
    },
  }
}

function isRateCardShape(value: unknown): value is AsrRateCard {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    (record['pricePerHourCny'] === null || typeof record['pricePerHourCny'] === 'number') &&
    (record['pricePerRequestCny'] === null || typeof record['pricePerRequestCny'] === 'number') &&
    typeof record['markupPermille'] === 'number' &&
    typeof record['mock'] === 'boolean'
  )
}

/**
 * env 布局：
 * - POLO_RELAY_ASR_DEFAULT_SUPPLIER：默认供应商 id（缺省 volcengine；本地联调设 mock）。
 * - POLO_RELAY_ASR_RATE_CARDS_JSON：可选 JSON 覆盖，
 *   形如 {"volcengine":{"mode":"STREAM","rateCard":{…}}}（deploy 时对齐 admin 配置）。
 */
export function supplierConfigFromEnv(env: Record<string, string | undefined> = process.env): AsrSupplierConfig {
  const suppliers = builtinSupplierConfig()
  const raw = env['POLO_RELAY_ASR_RATE_CARDS_JSON']
  if (raw !== undefined && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [supplier, value] of Object.entries(parsed)) {
        if (value === null || typeof value !== 'object') continue
        const entry = value as Record<string, unknown>
        const base = suppliers[supplier]
        const rateCard = isRateCardShape(entry['rateCard']) ? entry['rateCard'] : base?.rateCard
        if (!rateCard) continue
        suppliers[supplier] = {
          supplier,
          mode: entry['mode'] === 'FILE' ? 'FILE' : entry['mode'] === 'STREAM' ? 'STREAM' : (base?.mode ?? 'STREAM'),
          rateCard,
        }
      }
    } catch {
      // 配置损坏时保持内置默认（启动可用性优先；速率卡错误会在 quote 422 处显性化）。
    }
  }
  const defaultSupplier = env['POLO_RELAY_ASR_DEFAULT_SUPPLIER']?.trim() || 'volcengine'
  return { defaultSupplier, suppliers }
}

/** 测试注入用静态源。 */
export function staticSupplierConfigSource(config: AsrSupplierConfig): AsrSupplierConfigSource {
  return { load: () => config }
}

/**
 * 60s TTL 缓存的配置读取面（PRD §⑦：relay 缓存 admin 配置 60s）。缓存键恒为
 * 'current' —— 配置是单例快照；admin 下发端点就绪后仅替换 source。
 */
export class AsrCapabilityService {
  private readonly cache: TtlCache<string, AsrSupplierConfig>

  constructor(
    private readonly source: AsrSupplierConfigSource,
    private readonly cacheTtlMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(cacheTtlMs, now)
  }

  async current(): Promise<AsrSupplierConfig> {
    const cached = this.cache.get('current')
    if (cached) return cached
    const config = this.source.load()
    this.cache.set('current', config)
    return config
  }

  invalidate(): void {
    this.cache.clear()
  }
}
