// App-side ASR capability cache (POL-24) — the read-only mirror of the
// relay /asr handshake (asr_ready frame). PRD §⑦ 定案: 能力经握手下发，App 按
// realtimeStreaming 自适应渲染、不内置供应商分支（裁决 P-R1-01 选项 B）。
//
// The capabilities ride asr_ready — i.e. they are only knowable right after a
// press. The cache lets the NEXT press render the right 待按态 hints instantly
// (边说边出字 vs 整段转文字) instead of flashing the conservative default.
// 拿不到能力默认 FILE（保守）: a never-connected app shows the FILE panel and
// corrects itself as soon as the first asr_ready lands.

import type { AsrMode, AsrReadyInfo } from './asrSocket';

export interface CachedVoiceCapabilities {
  supplier: string;
  mode: AsrMode;
  realtimeStreaming: boolean;
  maxDurationSec: number;
  languages: string[];
  rateCard: AsrReadyInfo['rateCard'];
  seenAtMs: number;
}

class CapabilityCache {
  private cached: CachedVoiceCapabilities | null = null;

  update(info: AsrReadyInfo, nowMs: number): void {
    this.cached = {
      supplier: info.supplier,
      mode: info.mode,
      realtimeStreaming: info.realtimeStreaming,
      maxDurationSec: info.maxDurationSec,
      languages: info.languages,
      rateCard: info.rateCard,
      seenAtMs: nowMs,
    };
  }

  get(): CachedVoiceCapabilities | null {
    return this.cached;
  }

  clear(): void {
    this.cached = null;
  }
}

/** App-wide singleton (survives screen navigation within a launch). */
export const voiceCapabilityCache = new CapabilityCache();

/** Conservative branch decision — unknown capabilities degrade to FILE. */
export function resolveVoiceMode(cache: CachedVoiceCapabilities | null): AsrMode {
  return cache?.realtimeStreaming ? 'STREAM' : 'FILE';
}

/** Default single-utterance cap before the first handshake answers. */
export const DEFAULT_MAX_DURATION_SEC = 300;

export function maxDurationSecOf(cache: CachedVoiceCapabilities | null): number {
  const value = cache?.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
  return value > 0 ? value : DEFAULT_MAX_DURATION_SEC;
}

/** 临近上限提醒窗口（PRD §⑦: 剩约 30 秒面板内提醒）。 */
export const NEAR_CAP_WARNING_SEC = 30;
