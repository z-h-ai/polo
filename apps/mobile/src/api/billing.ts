// Voice billing HTTP API (POL-249 card step 4) — the M2-3 admin contract,
// field-by-field mirror of packages/relay/src/asr/billing.ts (verified against
// polo-admin src/app/api/billing/voice/{quote,prehold,settle}/route.ts):
//   POST /api/billing/voice/quote   {supplier, seconds}          → VoiceQuote
//   POST /api/billing/voice/prehold {preholdId, supplier, seconds?} → VoiceBillingTxn
//   POST /api/billing/voice/settle  {preholdId, action, actualSeconds?} → VoiceBillingTxn
//   errors: voice_insufficient_balance(409) / voice_not_quotable(422) via ApiError.
//
// NOTE (relay-source-is-contract deviation, see card report): in the live
// /asr flow the RELAY performs quote/prehold/settle server-side with its own
// preholdId — the App calls only `quote` (禁按态预检). prehold/settle/refund
// below remain for the direct-HTTP contract (tests + non-/asr consumers) and
// must not be fired against a relay-owned preholdId (idempotent replay).

import { apiClient } from './client';
import type { ApiClient } from './client';

export interface VoiceQuoteView {
  supplier: string;
  seconds: number;
  credits: number | null;
  quoted: boolean;
  pricePerHourCny: number | null;
  markupPermille: number;
}

export interface VoiceBillingTxnView {
  preholdId: string;
  userId: string;
  supplier: string;
  status: 'PENDING' | 'SETTLED' | 'REFUNDED' | 'EXPIRED';
  preholdSeconds: number;
  preholdCredits: number;
  settleSeconds: number | null;
  settleCredits: number | null;
  balanceAfter: number;
  idempotentReplay: boolean;
}

export interface VoiceBillingApi {
  quote(supplier: string, seconds: number): Promise<VoiceQuoteView>;
  prehold(input: { preholdId: string; supplier: string; seconds?: number }): Promise<VoiceBillingTxnView>;
  settle(input: { preholdId: string; action: 'settle' | 'refund'; actualSeconds?: number }): Promise<VoiceBillingTxnView>;
}

const QUOTE_SECONDS = 60;

export function createVoiceBillingApi(client: ApiClient): VoiceBillingApi {
  return {
    quote(supplier, seconds) {
      return client.post<VoiceQuoteView>('/api/billing/voice/quote', { supplier, seconds });
    },
    prehold(input) {
      return client.post<VoiceBillingTxnView>('/api/billing/voice/prehold', {
        preholdId: input.preholdId,
        supplier: input.supplier,
        ...(input.seconds !== undefined ? { seconds: input.seconds } : {}),
      });
    },
    settle(input) {
      return client.post<VoiceBillingTxnView>('/api/billing/voice/settle', {
        preholdId: input.preholdId,
        action: input.action,
        ...(input.action === 'settle' ? { actualSeconds: input.actualSeconds ?? 0 } : {}),
      });
    },
  };
}

/** App-wide singleton on the shared admin client (auth/refresh handled there). */
export const voiceBillingApi = createVoiceBillingApi(apiClient);

/** The prehold budget quoted for the 禁按态预检 (PRD §⑦ 预扣 60 秒). */
export const VOICE_PREHOLD_QUOTE_SECONDS = QUOTE_SECONDS;
