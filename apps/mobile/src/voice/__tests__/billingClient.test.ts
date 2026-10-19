// POL-249 unit tests for the voice billing client layer (bun test; the network
// and the admin API client are fakes — no real HTTP).
//
// Card 自检 matrix covered here:
//   - M2-3 契约映射（quote/prehold/settle 的路径与请求体形状、settle 仅 settle
//     携带 actualSeconds、refund 不带）
//   - 禁按态 gate：quote 200 ok / 409 voice_insufficient_balance → 禁按 /
//     422 voice_not_quotable → 不可报价 / 网络失败 → 回 unknown（按住时握手裁定）
//   - 预扣/结算数值展示（用时 Xs·预扣已退回 Ys / 已补扣 / 预扣 chip 文案）

import { beforeEach, describe, expect, test } from 'bun:test';

import { createVoiceBillingApi, VOICE_PREHOLD_QUOTE_SECONDS } from '../../api/billing';
import type { ApiClient } from '../../api/client';
import {
  newLocalPreholdId,
  preholdChipLabel,
  settlementSummary,
  useVoiceQuotaGate,
} from '../billingClient';
import type { VoiceBillingApi } from '../../api/billing';

// ---------------------------------------------------------------------------
// M2-3 contract mapping (fake ApiClient captures calls)
// ---------------------------------------------------------------------------

describe('createVoiceBillingApi（M2-3 契约）', () => {
  function makeFakeClient(response: unknown = {}) {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client: Pick<ApiClient, 'post'> = {
      post: async <T>(path: string, body?: unknown) => {
        calls.push({ path, body });
        return response as T;
      },
    };
    return { calls, api: createVoiceBillingApi(client as ApiClient) };
  }

  test('quote → POST /api/billing/voice/quote {supplier, seconds}', async () => {
    const { calls, api } = makeFakeClient({
      supplier: 'volcengine',
      seconds: 60,
      credits: 12,
      quoted: true,
      pricePerHourCny: 4.5,
      markupPermille: 1300,
    });
    const quote = await api.quote('volcengine', 60);
    expect(calls).toEqual([
      { path: '/api/billing/voice/quote', body: { supplier: 'volcengine', seconds: 60 } },
    ]);
    expect(quote.credits).toBe(12);
    expect(quote.quoted).toBe(true);
  });

  test('prehold → POST /api/billing/voice/prehold（preholdId 本地生成，秒数可选）', async () => {
    const { calls, api } = makeFakeClient({ status: 'PENDING' });
    const preholdId = newLocalPreholdId();
    await api.prehold({ preholdId, supplier: 'mimo' });
    expect(calls[0]).toEqual({
      path: '/api/billing/voice/prehold',
      body: { preholdId, supplier: 'mimo' },
    });
    expect(preholdId).toMatch(/^ph-|[0-9a-f]{8}-/);
  });

  test('settle → action=settle 携带 actualSeconds；refund 不携带', async () => {
    const { calls, api } = makeFakeClient({ status: 'SETTLED' });
    await api.settle({ preholdId: 'p1', action: 'settle', actualSeconds: 8 });
    await api.settle({ preholdId: 'p1', action: 'refund' });
    expect(calls).toEqual([
      { path: '/api/billing/voice/settle', body: { preholdId: 'p1', action: 'settle', actualSeconds: 8 } },
      { path: '/api/billing/voice/settle', body: { preholdId: 'p1', action: 'refund' } },
    ]);
  });

  test('预扣秒数常量 = PRD §⑦ 的 60 秒', () => {
    expect(VOICE_PREHOLD_QUOTE_SECONDS).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// 禁按态 gate store
// ---------------------------------------------------------------------------

describe('useVoiceQuotaGate（P07 禁按态）', () => {
  beforeEach(() => {
    useVoiceQuotaGate.getState().reset();
  });

  function gateWithQuote(api: Partial<VoiceBillingApi>) {
    return useVoiceQuotaGate.getState().refresh('volcengine', 60, api as VoiceBillingApi);
  }

  test('supplier 未知（尚未握手）→ 不发 quote，保持 unknown', async () => {
    await useVoiceQuotaGate.getState().refresh(null);
    expect(useVoiceQuotaGate.getState().status).toBe('unknown');
  });

  test('quote ok → 按钮可用（ok + supplier）', async () => {
    await gateWithQuote({
      quote: async () => ({
        supplier: 'volcengine',
        seconds: 60,
        credits: 12,
        quoted: true,
        pricePerHourCny: 4.5,
        markupPermille: 1300,
      }),
    });
    const state = useVoiceQuotaGate.getState();
    expect(state.status).toBe('ok');
    expect(state.supplier).toBe('volcengine');
  });

  test('quote 409 voice_insufficient_balance → insufficient（禁按）', async () => {
    const error = Object.assign(new Error('语音积分不足'), { errorCode: 'voice_insufficient_balance' });
    await gateWithQuote({ quote: async () => Promise.reject(error) });
    expect(useVoiceQuotaGate.getState().status).toBe('insufficient');
  });

  test('quote 422 voice_not_quotable → not_quotable', async () => {
    const error = Object.assign(new Error('供应商未定价'), { errorCode: 'voice_not_quotable' });
    await gateWithQuote({ quote: async () => Promise.reject(error) });
    expect(useVoiceQuotaGate.getState().status).toBe('not_quotable');
  });

  test('网络失败 → 回 unknown（不猜测；按住时 /asr 握手 fail-closed 裁定）', async () => {
    await gateWithQuote({ quote: async () => Promise.reject(new Error('NetworkError')) });
    expect(useVoiceQuotaGate.getState().status).toBe('unknown');
  });

  test('quoted=false（未定价语义）→ not_quotable', async () => {
    await gateWithQuote({
      quote: async () => ({
        supplier: 'mimo',
        seconds: 60,
        credits: null,
        quoted: false,
        pricePerHourCny: null,
        markupPermille: 1300,
      }),
    });
    expect(useVoiceQuotaGate.getState().status).toBe('not_quotable');
  });

  test('markAvailable（asr_ready 权威）清除禁按态；markInsufficient 进入禁按态', () => {
    useVoiceQuotaGate.getState().markInsufficient(1);
    expect(useVoiceQuotaGate.getState().status).toBe('insufficient');
    useVoiceQuotaGate.getState().markAvailable('volcengine');
    expect(useVoiceQuotaGate.getState().status).toBe('ok');
    expect(useVoiceQuotaGate.getState().supplier).toBe('volcengine');
  });
});

// ---------------------------------------------------------------------------
// 预扣/结算数值展示（纯函数）
// ---------------------------------------------------------------------------

describe('结算展示数值（多退少补）', () => {
  test('8s/60s → 退回 52 秒（P09 okbar 文案）', () => {
    const summary = settlementSummary(8, 60);
    expect(summary.usedSeconds).toBe(8);
    expect(summary.returnedSeconds).toBe(52);
    expect(summary.toppedUpSeconds).toBe(0);
    expect(summary.label).toBe('用时 8 秒 · 预扣的 60 秒已退回 52 秒积分');
  });

  test('60s/60s → 无退无补', () => {
    const summary = settlementSummary(60, 60);
    expect(summary.returnedSeconds).toBe(0);
    expect(summary.label).toBe('用时 60 秒 · 预扣的 60 秒已用完');
  });

  test('70s/60s → 补扣 10 秒', () => {
    const summary = settlementSummary(70, 60);
    expect(summary.toppedUpSeconds).toBe(10);
    expect(summary.returnedSeconds).toBe(0);
    expect(summary.label).toBe('用时 70 秒 · 预扣 60 秒已用完，已补扣 10 秒积分');
  });

  test('0s（无音频全退口径）→ 全额退回', () => {
    const summary = settlementSummary(0, 60);
    expect(summary.returnedSeconds).toBe(60);
    expect(summary.label).toBe('用时 0 秒 · 预扣的 60 秒已退回 60 秒积分');
  });
});

describe('预扣 chip 文案', () => {
  test('7s/60s → 「预扣 60s 剩 53s」；用完 → 「预扣 60s 已用完」', () => {
    expect(preholdChipLabel(7, 60)).toBe('预扣 60s 剩 53s');
    expect(preholdChipLabel(60, 60)).toBe('预扣 60s 已用完');
    expect(preholdChipLabel(292, 60)).toBe('预扣 60s 已用完');
  });
});
