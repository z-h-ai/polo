// Voice billing client (POL-24 card step 4) — the App-side interaction layer
// on top of src/api/billing.ts (M2-3 contract).
//
// Division of labour (verified against packages/relay/src/asr/service.ts —
// relay source is authoritative, App adapts):
//   - the /asr WS handshake performs quote + prehold(60s) RELAY-SIDE before
//     asr_ready (its own preholdId); settle/refund run on end/cancel/close.
//     The App therefore NEVER fires prehold/settle against the live flow —
//     double-settling a relay-owned preholdId would be an idempotent replay
//     at best.
//   - what the App DOES own:
//       · quote        — the P07 禁按态 pre-check (余额不足 → 置灰+锁+去充值);
//       · settlement summary math — 「用时 Xs · 预扣的 60 秒已退回 Ys 积分」
//         derived from asr_ready.preholdSeconds + asr_final.seconds;
//       · the M2-3 prehold/settle client functions (contract parity, tests,
//         non-/asr consumers) with locally generated preholdId (UUID).

import { create } from 'zustand';

import type { VoiceBillingApi, VoiceQuoteView } from '../api/billing';
import { VOICE_PREHOLD_QUOTE_SECONDS, voiceBillingApi } from '../api/billing';

// ---------------------------------------------------------------------------
// Settlement display math (pure)
// ---------------------------------------------------------------------------

export interface VoiceSettlement {
  /** asr_final.seconds (relay 实测计量，计费唯一来源). */
  usedSeconds: number;
  preholdSeconds: number;
  /** 多退：prehold − used，负值=补扣（少退多补，多退少补）. */
  returnedSeconds: number;
  toppedUpSeconds: number;
  /** P09 okbar 文案. */
  label: string;
}

export function settlementSummary(usedSeconds: number, preholdSeconds: number): VoiceSettlement {
  const used = Math.max(0, Math.round(usedSeconds));
  const prehold = Math.max(0, Math.round(preholdSeconds));
  if (used <= prehold) {
    const returned = prehold - used;
    return {
      usedSeconds: used,
      preholdSeconds: prehold,
      returnedSeconds: returned,
      toppedUpSeconds: 0,
      label:
        returned > 0
          ? `用时 ${used} 秒 · 预扣的 ${prehold} 秒已退回 ${returned} 秒积分`
          : `用时 ${used} 秒 · 预扣的 ${prehold} 秒已用完`,
    };
  }
  const toppedUp = used - prehold;
  return {
    usedSeconds: used,
    preholdSeconds: prehold,
    returnedSeconds: 0,
    toppedUpSeconds: toppedUp,
    label: `用时 ${used} 秒 · 预扣 ${prehold} 秒已用完，已补扣 ${toppedUp} 秒积分`,
  };
}

/** Recording chip label: 「预扣 60s 剩 53s」 / 「预扣 60s 已用完」. */
export function preholdChipLabel(elapsedSec: number, preholdSeconds: number): string {
  if (elapsedSec >= preholdSeconds) return `预扣 ${preholdSeconds}s 已用完`;
  return `预扣 ${preholdSeconds}s 剩 ${preholdSeconds - elapsedSec}s`;
}

// ---------------------------------------------------------------------------
// Quota gate store — the P07 禁按态 source of truth
// ---------------------------------------------------------------------------

export type VoiceQuotaStatus = 'unknown' | 'checking' | 'ok' | 'insufficient' | 'not_quotable';

export interface VoiceQuotaState {
  status: VoiceQuotaStatus;
  quote: VoiceQuoteView | null;
  /** rateCard.mock 透传 — App 展示带演示标注，不可作真实价格. */
  mockPricing: boolean;
  supplier: string | null;
  checkedAtMs: number;
  insufficientAtMs: number;
}

export interface VoiceQuotaActions {
  markInsufficient(nowMs: number): void;
  markNotQuotable(nowMs: number): void;
  markOk(quote: VoiceQuoteView, nowMs: number): void;
  /** /asr 握手 prehold 成功（asr_ready）— 权威证明当前可按. */
  markAvailable(supplier: string): void;
  /** Session screen entry — quote when the supplier is known (from the cache). */
  refresh(supplier: string | null, seconds?: number, api?: VoiceBillingApi): Promise<void>;
  reset(): void;
}

export type VoiceQuotaStore = VoiceQuotaState & VoiceQuotaActions;

export const useVoiceQuotaGate = create<VoiceQuotaStore>((set, get) => ({
  status: 'unknown',
  quote: null,
  mockPricing: false,
  supplier: null,
  checkedAtMs: 0,
  insufficientAtMs: 0,

  markInsufficient(nowMs) {
    set({ status: 'insufficient', quote: null, insufficientAtMs: nowMs });
  },

  markNotQuotable(nowMs) {
    set({ status: 'not_quotable', quote: null, insufficientAtMs: nowMs });
  },

  markOk(quote, nowMs) {
    set({
      status: 'ok',
      quote,
      supplier: quote.supplier,
      checkedAtMs: nowMs,
    });
  },

  markAvailable(supplier) {
    // asr_ready = relay 已 quote+prehold 成功（权威），清掉任何过期的禁按态.
    set({ status: 'ok', supplier, quote: null });
  },

  async refresh(supplier, seconds = VOICE_PREHOLD_QUOTE_SECONDS, api: VoiceBillingApi = voiceBillingApi) {
    if (!supplier) return; // 能力未知（尚未握手过）→ 保持 unknown，按住时握手裁定
    if (get().status === 'checking') return;
    set({ status: 'checking' });
    try {
      const quote = await api.quote(supplier, seconds);
      if (quote.quoted !== true || quote.credits === null) {
        set({ status: 'not_quotable', quote: null, supplier, checkedAtMs: Date.now() });
        return;
      }
      set({ status: 'ok', quote, supplier, mockPricing: false, checkedAtMs: Date.now() });
    } catch (error) {
      const code = (error as { errorCode?: string }).errorCode;
      if (code === 'voice_insufficient_balance') {
        set({ status: 'insufficient', quote: null, supplier, insufficientAtMs: Date.now() });
        return;
      }
      if (code === 'voice_not_quotable') {
        set({ status: 'not_quotable', quote: null, supplier, checkedAtMs: Date.now() });
        return;
      }
      // 网络等失败不猜：回到 unknown（按住时 /asr 握手 fail-closed 裁定）。
      set({ status: 'unknown', checkedAtMs: Date.now() });
    }
  },

  reset() {
    set({ status: 'unknown', quote: null, mockPricing: false, supplier: null, checkedAtMs: 0, insufficientAtMs: 0 });
  },
}));

/** Local UUID for contract-complete direct prehold calls (non-/asr paths). */
export function newLocalPreholdId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
