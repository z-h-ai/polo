// POL-24 unit tests for the PRD §⑦ 双模式状态机 (bun test; fake clock, no
// real timers, no network, no native audio — recorder/socket/billing are fakes).
//
// Card 自检 matrix covered here:
//   - STREAM 流式上屏序列（partial 累计快照按 seq 单调、松开 end→final→预览）
//   - FILE 松开转写（本地攒段→wav 容器整段上送→{end}）+ SSE 渐进
//   - 上滑取消（阈值判定）→ {cancel} → 「已取消，预扣积分将退回」toast → 自动回待按
//   - 余额不足禁按（asr_error insufficient_balance → gate 禁按 → press 打不开面板之外的状态）
//   - 到顶自动停止（5 分钟视同松开 + toast）
//   - 后处理失败原文降级（P09 ④）
//   - 预扣/结算数值展示（用时 Xs · 预扣的 60 秒已退回 Ys / 补扣）
//   - 手势判定（松开 vs 上滑阈值 -48px）
//   - wav 容器 / 本地 metering 纯函数

import { describe, expect, test } from 'bun:test';

import { createPressToTalkMachine, FINAL_WAIT_TIMEOUT_MS, SWIPE_UP_CANCEL_PX } from '../usePressToTalk';
import type { PressToTalkMachine, QuotaGateLike } from '../usePressToTalk';
import type { AsrCloseInfo, AsrErrorFrameCode, AsrReadyInfo, AsrSessionHandlers, AsrSessionLike } from '../asrSocket';
import { parseAsrServerFrame } from '../asrSocket';
import type { VoiceRecorderLike } from '../audioRecorder';
import { encodeWav, pcmRmsLevel, WAV_HEADER_BYTES } from '../wav';

// ---------------------------------------------------------------------------
// Fake clock — same deterministic-timer pattern as the conn/outbox tests
// ---------------------------------------------------------------------------

interface FakeClock {
  now: () => number;
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  advance: (ms: number) => void;
}

function makeFakeClock(start = 1_000_000): FakeClock {
  let current = start;
  let seq = 0;
  const scheduled = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => current,
    timers: {
      set(fn, ms) {
        const id = ++seq;
        scheduled.set(id, { at: current + ms, fn });
        return id;
      },
      clear(handle) {
        scheduled.delete(handle as number);
      },
    },
    advance(ms) {
      const deadline = current + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of scheduled) {
          if (timer.at <= deadline && timer.at < nextAt) {
            nextAt = timer.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        current = nextAt;
        const timer = scheduled.get(nextId);
        scheduled.delete(nextId);
        timer?.fn();
      }
      current = deadline;
    },
  };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeHarness(options: {
  quotaStatus?: QuotaGateLike;
  gateCalls?: { insufficient: number; notQuotable: number; available: string[] };
} = {}) {
  const clock = makeFakeClock();
  let handlers: AsrSessionHandlers | null = null;
  const sentFrames: Array<string | ArrayBuffer | Uint8Array> = [];
  let finishCount = 0;
  let cancelCount = 0;
  let closeCount = 0;

  const fakeSession: AsrSessionLike = {
    get readyInfo() {
      return null;
    },
    sendAudioBytes(bytes) {
      sentFrames.push(bytes);
    },
    sendAudioBase64(data) {
      sentFrames.push(data);
    },
    finish() {
      finishCount += 1;
    },
    cancel() {
      cancelCount += 1;
    },
    close() {
      closeCount += 1;
    },
  };

  const recorder: VoiceRecorderLike & { startCount: number; stopCount: number } = {
    startCount: 0,
    stopCount: 0,
    get running() {
      return this.startCount > this.stopCount;
    },
    async start() {
      this.startCount += 1;
    },
    stop() {
      this.stopCount += 1;
    },
  };

  const gate: QuotaGateLike & {
    status: 'unknown' | 'ok' | 'insufficient' | 'not_quotable' | 'checking';
    insufficient: number;
    notQuotable: number;
    available: string[];
  } = {
    status: 'unknown',
    insufficient: 0,
    notQuotable: 0,
    available: [],
    getState() {
      return {
        status: gate.status,
        markInsufficient: (at: number) => {
          void at;
          gate.insufficient += 1;
          gate.status = 'insufficient';
        },
        markNotQuotable: (at: number) => {
          void at;
          gate.notQuotable += 1;
          gate.status = 'not_quotable';
        },
        markAvailable: (supplier: string) => {
          gate.available.push(supplier);
          gate.status = 'ok';
        },
      };
    },
  };

  let resolvePostProcess: ((value: { processedText: string }) => void) | null = null;
  let rejectPostProcess: ((error: unknown) => void) | null = null;
  let postProcessCalls = 0;

  const machine: PressToTalkMachine = createPressToTalkMachine({
    recorder,
    connect: async (sessionHandlers) => {
      handlers = sessionHandlers;
      return fakeSession;
    },
    postProcess: (text) => {
      postProcessCalls += 1;
      return new Promise<{ processedText: string }>((resolve, reject) => {
        resolvePostProcess = resolve;
        rejectPostProcess = reject;
        void text;
      });
    },
    onSend: (text) => {
      sentTexts.push(text);
    },
    quota: gate,
    now: clock.now,
    timers: clock.timers,
  });

  const sentTexts: string[] = [];

  async function press(): Promise<void> {
    machine.pressStart();
    await flushMicrotasks();
  }

  function ready(info: Partial<AsrReadyInfo> = {}): void {
    handlers?.onReady({
      supplier: 'volcengine',
      mode: 'STREAM',
      realtimeStreaming: true,
      maxDurationSec: 300,
      languages: ['zh'],
      rateCard: { pricePerHourCny: 4.5, pricePerRequestCny: null, markupPermille: 1300, mock: false },
      preholdSeconds: 60,
      preholdCredits: 12,
      preholdId: 'relay-prehold-1',
      ...info,
    });
  }

  return {
    clock,
    machine,
    gate,
    recorder,
    sentFrames,
    sentTexts,
    counts: {
      get finish() {
        return finishCount;
      },
      get cancel() {
        return cancelCount;
      },
      get close() {
        return closeCount;
      },
    },
    get handlers(): AsrSessionHandlers | null {
      return handlers;
    },
    get postProcessState() {
      return {
        calls: postProcessCalls,
        resolve: () => resolvePostProcess?.({ processedText: '结构化后的文本' }),
        reject: () => rejectPostProcess?.(new Error('post-process unavailable')),
      };
    },
    press,
    ready,
  };
}

// ---------------------------------------------------------------------------
// STREAM 流式上屏序列
// ---------------------------------------------------------------------------

describe('STREAM 模式（边说边出字）', () => {
  test('按住 → asr_ready(STREAM) → partial 渐进上屏（seq 单调）→ 松开 end → final → 后处理 → 预览', async () => {
    const harness = makeHarness();
    await harness.press();
    expect(harness.machine.getState().phase).toBe('recording');
    // 握手前无能力缓存 → 保守 FILE 分支；asr_ready 后自适应切 STREAM
    expect(harness.machine.getState().mode).toBe('FILE');

    harness.ready();
    expect(harness.machine.getState().ready).toBe(true);
    expect(harness.machine.getState().mode).toBe('STREAM');
    expect(harness.machine.getState().preholdSeconds).toBe(60);

    harness.handlers!.onPartial('帮我把这份', 1);
    expect(harness.machine.getState().phase).toBe('recognizing');
    expect(harness.machine.getState().partialText).toBe('帮我把这份');

    harness.handlers!.onPartial('帮我把这份季度文档总结成三个要', 2);
    expect(harness.machine.getState().partialText).toBe('帮我把这份季度文档总结成三个要');

    // 累计快照的迟到重放（seq 回退）不回退文案
    harness.handlers!.onPartial('帮我把这份', 1);
    expect(harness.machine.getState().partialText).toBe('帮我把这份季度文档总结成三个要');

    harness.machine.pressEnd();
    expect(harness.counts.finish).toBe(1);
    expect(harness.machine.getState().phase).toBe('recognizing'); // 等待 final

    harness.handlers!.onFinal('帮我把这份季度文档总结成三个要点', 8);
    expect(harness.machine.getState().phase).toBe('postProcessing');
    harness.postProcessState.resolve();
    await flushMicrotasks();

    const preview = harness.machine.getState();
    expect(preview.phase).toBe('preview');
    expect(preview.processing.status).toBe('done');
    expect(preview.draft).toBe('结构化后的文本');
    expect(preview.showRaw).toBe(false);

    // 发送走 onSend（SessionController 链路）→ 已发送 → 自动回待按
    harness.machine.sendPreview();
    expect(harness.sentTexts).toEqual(['结构化后的文本']);
    expect(harness.machine.getState().phase).toBe('sent');
    harness.clock.advance(900);
    expect(harness.machine.getState().phase).toBe('idle');
  });

  test('松开后等待 final 超时 → 全退回待按（FINAL_WAIT_TIMEOUT_MS）', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.machine.pressEnd();
    harness.clock.advance(FINAL_WAIT_TIMEOUT_MS);
    const state = harness.machine.getState();
    expect(state.phase).toBe('cancelled');
    expect(state.toast?.message).toContain('转写超时');
    expect(state.toast?.message).toContain('全额退回');
  });
});

// ---------------------------------------------------------------------------
// FILE 松开转写 + SSE 渐进
// ---------------------------------------------------------------------------

describe('FILE 模式（整段转文字）', () => {
  test('本地攒段 → 松开整段 wav 上送 + end → SSE partial 渐进 → final', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready({ mode: 'FILE', realtimeStreaming: false, supplier: 'mimo' });
    expect(harness.machine.getState().mode).toBe('FILE');

    // 录音期间无流式文字、无分片上送（协议限制整段上送）
    harness.machine.__feedPcm(new Uint8Array([1, 2, 3, 4]), 0.5);
    harness.machine.__feedPcm(new Uint8Array([5, 6, 7, 8]), 0.6);
    expect(harness.sentFrames.length).toBe(0);
    expect(harness.machine.getState().partialText).toBe('');
    expect(harness.machine.getState().level).toBeCloseTo(0.6);

    harness.machine.pressEnd(); // 松开 → wav 整段上送
    expect(harness.sentFrames.length).toBe(1);
    const wav = harness.sentFrames[0] as Uint8Array;
    expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe('RIFF');
    expect(wav.length).toBe(WAV_HEADER_BYTES + 8);
    expect(harness.counts.finish).toBe(1);
    expect(harness.machine.getState().phase).toBe('recognizing'); // 转写中

    // SSE 渐进（relay 把 MiMo delta 累计为全文快照）
    harness.handlers!.onPartial('帮我把这个季度文档', 1);
    expect(harness.machine.getState().phase).toBe('recognizing');
    expect(harness.machine.getState().partialText).toBe('帮我把这个季度文档');

    harness.handlers!.onFinal('帮我把这个季度文档总结一下', 12);
    harness.postProcessState.resolve();
    await flushMicrotasks();
    expect(harness.machine.getState().phase).toBe('preview');
    expect(harness.machine.getState().draft).toBe('结构化后的文本');
  });

  test('FILE 松开时无音频 → 走取消（relay 0 秒全退口径）', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready({ mode: 'FILE', realtimeStreaming: false, supplier: 'mimo' });
    harness.machine.pressEnd();
    expect(harness.counts.cancel).toBe(1);
    expect(harness.counts.finish).toBe(0);
    expect(harness.machine.getState().phase).toBe('cancelled');
    expect(harness.machine.getState().toast?.message).toBe('已取消，预扣积分将退回');
  });
});

// ---------------------------------------------------------------------------
// 手势判定（松开 vs 上滑）与取消
// ---------------------------------------------------------------------------

describe('手势判定与上滑取消', () => {
  test('纵向位移越过 -48px 阈值武装上滑；上滑松开 → cancel + 全退 toast + 自动回待按', async () => {
    expect(SWIPE_UP_CANCEL_PX).toBe(48);
    const harness = makeHarness();
    await harness.press();
    harness.ready();

    harness.machine.pressMove(-20);
    expect(harness.machine.getState().swipeArmed).toBe(false);
    harness.machine.pressMove(-60);
    expect(harness.machine.getState().swipeArmed).toBe(true);

    harness.machine.pressEnd();
    expect(harness.counts.cancel).toBe(1);
    expect(harness.counts.finish).toBe(0);
    const state = harness.machine.getState();
    expect(state.phase).toBe('cancelled');
    expect(state.cancelReason).toBe('swipe');
    expect(state.toast?.message).toBe('已取消，预扣积分将退回');

    harness.clock.advance(1800);
    expect(harness.machine.getState().phase).toBe('idle');
  });

  test('阈值内原位松开 → 转文字而非取消', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.machine.pressMove(-10);
    harness.machine.pressEnd();
    expect(harness.counts.cancel).toBe(0);
    expect(harness.counts.finish).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 余额不足禁按
// ---------------------------------------------------------------------------

describe('余额不足禁按（P07）', () => {
  test('gate insufficient → press 不进入录音，打开禁按面板', async () => {
    const harness = makeHarness();
    harness.gate.status = 'insufficient';
    await harness.press();
    const state = harness.machine.getState();
    expect(state.phase).toBe('idle');
    expect(state.insufficientPanel).toBe(true);
    expect(harness.recorder.startCount).toBe(0);
  });

  test('asr_error insufficient_balance → gate 置禁按 + 回待按 + 提示', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.handlers!.onError('insufficient_balance' as AsrErrorFrameCode, '余额不足');
    const state = harness.machine.getState();
    expect(harness.gate.insufficient).toBe(1);
    expect(state.phase).toBe('cancelled');
    expect(state.toast?.message).toContain('语音积分不足');
    // 禁按后再次按住 → 打开 P07 面板
    harness.clock.advance(1800);
    harness.machine.pressStart();
    expect(harness.machine.getState().insufficientPanel).toBe(true);
    expect(harness.machine.getState().phase).toBe('idle');
  });

  test('close 4402（prehold 409）同样进入禁按态', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.handlers!.onClosed({ code: 4402 } as AsrCloseInfo);
    expect(harness.gate.insufficient).toBe(1);
    expect(harness.machine.getState().phase).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// 到顶自动停止（单次上限 5 分钟）
// ---------------------------------------------------------------------------

describe('到顶自动停止', () => {
  test('300 秒到顶视同松开：end + toast「已自动停止并转入文字」', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready({ maxDurationSec: 300 });

    harness.clock.advance(270_000); // 4:30 — 临近上限提醒
    const nearCap = harness.machine.getState();
    expect(nearCap.elapsedSec).toBe(270);
    expect(nearCap.nearCap).toBe(true);

    harness.clock.advance(30_000); // 5:00 — 到顶
    expect(harness.counts.finish).toBe(1);
    const stopped = harness.machine.getState();
    expect(stopped.phase).toBe('recognizing'); // 视同松开：等待 final
    expect(stopped.fingerDown).toBe(false);
    // 到顶 toast 先于 final 展示（屏顶反馈）
    expect(stopped.toast?.message).toBe('已达单次最长 5 分钟，已自动停止并转入文字');
  });

  test('临近上限窗口 = 上限前 30 秒', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready({ maxDurationSec: 300 });
    harness.clock.advance(269_000);
    expect(harness.machine.getState().nearCap).toBe(false);
    harness.clock.advance(1_000);
    expect(harness.machine.getState().nearCap).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 后处理失败降级 + 预扣/结算数值展示
// ---------------------------------------------------------------------------

describe('后处理与结算提示', () => {
  test('后处理失败 → P09 ④ 保留识别原文（可直接编辑/发送）', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.machine.pressEnd();
    harness.handlers!.onFinal('呃……帮我把这个季度文档总结一下', 8);
    harness.postProcessState.reject();
    await flushMicrotasks();

    const state = harness.machine.getState();
    expect(state.phase).toBe('preview');
    expect(state.processing.status).toBe('failed');
    expect(state.showRaw).toBe(true);
    expect(state.draft).toBe('呃……帮我把这个季度文档总结一下');
    // 失败态发送原文直发（保底）
    harness.machine.sendPreview();
    expect(harness.sentTexts).toEqual(['呃……帮我把这个季度文档总结一下']);
  });

  test('结算数值：8s/60s → 退回 52 秒', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready({ preholdSeconds: 60 });
    harness.machine.pressEnd();
    harness.handlers!.onFinal('要点总结', 8);
    expect(harness.machine.getState().settlement?.label).toBe('用时 8 秒 · 预扣的 60 秒已退回 52 秒积分');
    expect(harness.machine.getState().settlement?.returnedSeconds).toBe(52);
  });

  test('结算数值：70s/60s → 补扣 10 秒', async () => {
    // final 单会话只消费一次（finalSeen）——补扣场景用独立会话验证
    const harness2 = makeHarness();
    await harness2.press();
    harness2.ready({ preholdSeconds: 60 });
    harness2.machine.pressEnd();
    harness2.handlers!.onFinal('要点总结', 70);
    const settled = harness2.machine.getState();
    expect(settled.settlement?.label).toBe('用时 70 秒 · 预扣 60 秒已用完，已补扣 10 秒积分');
    expect(settled.settlement?.toppedUpSeconds).toBe(10);
  });

  test('预览取消 → 已取消；使用原文 ↔ 使用结构化 一键互切', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.machine.pressEnd();
    harness.handlers!.onFinal('原始话语', 8);
    harness.postProcessState.resolve();
    await flushMicrotasks();

    harness.machine.toggleRaw();
    expect(harness.machine.getState().showRaw).toBe(true);
    expect(harness.machine.getState().draft).toBe('原始话语');
    harness.machine.toggleRaw();
    expect(harness.machine.getState().showRaw).toBe(false);
    expect(harness.machine.getState().draft).toBe('结构化后的文本');

    harness.machine.cancelPreview();
    expect(harness.machine.getState().phase).toBe('cancelled');
    expect(harness.machine.getState().cancelReason).toBe('preview');
  });

  test('编辑草稿后发送编辑文本（候选规则 v1.6）', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.machine.pressEnd();
    harness.handlers!.onFinal('原始话语', 8);
    harness.postProcessState.resolve();
    await flushMicrotasks();
    harness.machine.setDraft('结构化后的文本（已修正）');
    harness.machine.sendPreview();
    expect(harness.sentTexts).toEqual(['结构化后的文本（已修正）']);
  });
});

// ---------------------------------------------------------------------------
// 握手失败 / 权限 / 消费帧解析
// ---------------------------------------------------------------------------

describe('握手失败与权限三态', () => {
  test('connect 失败 → 「语音连接失败」回待按', async () => {
    const clock = makeFakeClock();
    const machine = createPressToTalkMachine({
      recorder: {
        start: async () => undefined,
        stop: () => undefined,
        running: false,
      },
      connect: async () => {
        await flushMicrotasks(1);
        throw new Error('handshake timeout');
      },
      postProcess: async (text) => ({ processedText: text }),
      onSend: () => undefined,
      now: clock.now,
      timers: clock.timers,
    });
    machine.pressStart();
    await flushMicrotasks(8);
    const state = machine.getState();
    expect(state.phase).toBe('cancelled');
    expect(state.toast?.message).toContain('语音连接失败');
  });

  test('麦克风权限被拒 → 不录音，记录三态（应用内引导由面板渲染）', async () => {
    const clock = makeFakeClock();
    let openSettingsCalls = 0;
    const machine = createPressToTalkMachine({
      recorder: {
        start: async () => undefined,
        stop: () => undefined,
        running: false,
      },
      connect: async () => {
        throw new Error('should not connect');
      },
      postProcess: async (text) => ({ processedText: text }),
      onSend: () => undefined,
      permission: {
        ensure: async () => 'denied',
        openSettings: () => {
          openSettingsCalls += 1;
        },
      },
      now: clock.now,
      timers: clock.timers,
    });
    machine.pressStart();
    await flushMicrotasks(8);
    const state = machine.getState();
    expect(state.phase).toBe('idle');
    expect(state.micPermission).toBe('denied');
    expect(state.phase).not.toBe('recording');
    machine.openMicSettings();
    expect(openSettingsCalls).toBe(1);
  });

  test('parseAsrServerFrame 接受 relay 帧形状、拒绝噪声', () => {
    const ready = parseAsrServerFrame(
      JSON.stringify({
        type: 'asr_ready',
        supplier: 'volcengine',
        mode: 'STREAM',
        realtimeStreaming: true,
        maxDurationSec: 300,
        languages: ['zh'],
        rateCard: { pricePerHourCny: 4.5, pricePerRequestCny: null, markupPermille: 1300, mock: false },
        preholdSeconds: 60,
        preholdCredits: 12,
        preholdId: 'p1',
      }),
    );
    expect(ready?.type).toBe('asr_ready');
    expect(parseAsrServerFrame('{"type":"asr_partial","text":"你好","seq":3}')?.type).toBe('asr_partial');
    expect(parseAsrServerFrame('{"type":"asr_final","text":"你好","seconds":8}')?.type).toBe('asr_final');
    expect(parseAsrServerFrame('{"type":"asr_error","code":"upstream_error","message":"x"}')?.type).toBe('asr_error');
    expect(parseAsrServerFrame('{"type":"ping"}')).toBeNull();
    expect(parseAsrServerFrame('not json')).toBeNull();
    expect(parseAsrServerFrame('{"type":"asr_ready","supplier":1}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POL-24 评审补测：积压补发 / recognizing 取消 / 互切保留编辑 / 计费措辞 / 孤儿 socket
// ---------------------------------------------------------------------------

describe('STREAM 握手窗口积压补发（asr_ready 前后）', () => {
  test('ready 前采样的音频在 ready 后按序补发并合帧；松开冲尾不重复上送', async () => {
    const harness = makeHarness();
    await harness.press();
    // 握手窗口（ready 前保守 FILE）：3×3000B 本地攒段，无上送
    harness.machine.__feedPcm(new Uint8Array(3000));
    harness.machine.__feedPcm(new Uint8Array(3000));
    harness.machine.__feedPcm(new Uint8Array(3000));
    expect(harness.sentFrames.length).toBe(0);

    harness.ready(); // onReady → drainPcmToStream（合帧 ≤100ms 目标 + 冲尾）
    expect(harness.sentFrames.length).toBe(2);
    expect((harness.sentFrames[0] as Uint8Array).length).toBe(6000); // 2×3000 合帧
    expect((harness.sentFrames[1] as Uint8Array).length).toBe(3000); // 尾帧
    // 上送帧率上界 = 音频字节率 / 3200B ≈ 10 帧/s < relay 20 msg/s 限流

    harness.machine.pressEnd(); // 尾已冲尽，不再补帧
    expect(harness.sentFrames.length).toBe(2);
    expect(harness.counts.finish).toBe(1);
  });

  test('ready 后实时分片经合帧器上送（非每回调一帧）', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready(); // 能力缓存为空 → ready 前无积压
    harness.machine.__feedPcm(new Uint8Array(1000));
    expect(harness.sentFrames.length).toBe(0); // 1000B < 3200B 目标，暂存
    harness.machine.__feedPcm(new Uint8Array(1000));
    harness.machine.__feedPcm(new Uint8Array(1000));
    harness.machine.__feedPcm(new Uint8Array(1000));
    expect(harness.sentFrames.length).toBe(1); // 攒满 3200B 才上一帧
    expect((harness.sentFrames[0] as Uint8Array).length).toBe(4000);
    harness.machine.pressEnd();
    expect(harness.sentFrames.length).toBe(1); // 尾已冲尽，松开不补帧
    expect(harness.counts.finish).toBe(1);
  });
});

describe('recognizing（转写中）取消', () => {
  test('P08 取消按钮 → {cancel} + 「预扣积分将退回」 + 自动回待按', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.handlers!.onPartial('部分结果', 1);
    expect(harness.machine.getState().phase).toBe('recognizing');
    harness.machine.cancelRecognizing();
    expect(harness.counts.cancel).toBe(1);
    expect(harness.counts.finish).toBe(0);
    const state = harness.machine.getState();
    expect(state.phase).toBe('cancelled');
    expect(state.toast?.message).toBe('已取消，预扣积分将退回');
    harness.clock.advance(1800);
    expect(harness.machine.getState().phase).toBe('idle');
  });
});

describe('预览互切不丢编辑（候选规则 v1.6）', () => {
  test('结构化编辑 → 切原文 → 切回保留编辑；原文编辑同样保留', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.machine.pressEnd();
    harness.handlers!.onFinal('原始话语', 8);
    harness.postProcessState.resolve();
    await flushMicrotasks();

    harness.machine.setDraft('结构化后的文本（已修正）');
    harness.machine.toggleRaw();
    expect(harness.machine.getState().draft).toBe('原始话语');
    harness.machine.setDraft('原始话语（也改过）');
    harness.machine.toggleRaw();
    expect(harness.machine.getState().draft).toBe('结构化后的文本（已修正）'); // 编辑未丢
    harness.machine.toggleRaw();
    expect(harness.machine.getState().draft).toBe('原始话语（也改过）'); // 反向亦然
  });
});

describe('错误措辞与 relay 结算语义一致', () => {
  test('session_timeout(4502) → 「按实际用时结算」，不得宣称全额退回', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.handlers!.onError('session_timeout' as AsrErrorFrameCode, 'wall clock');
    const state = harness.machine.getState();
    expect(state.toast?.message).toContain('按实际用时结算');
    expect(state.toast?.message).not.toContain('退回');
  });

  test('upstream_error → relay 全退（异步「将退回」，不夸大为「已退回」）', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.handlers!.onError('upstream_error' as AsrErrorFrameCode, 'boom');
    expect(harness.machine.getState().toast?.message).toContain('将全额退回');
    expect(harness.machine.getState().toast?.message).not.toContain('已全额退回');
  });

  test('close 4401（升级/计费鉴权拒，预扣未生效）→ 登录过期提示，无退款措辞', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.handlers!.onClosed({ code: 4401 } as AsrCloseInfo);
    const state = harness.machine.getState();
    expect(state.toast?.message).toContain('登录已过期');
    expect(state.toast?.message).not.toContain('退回');
  });

  test('断连（无 close code）→ 「按实际用量结算」（relay handleClose auto 口径）', async () => {
    const harness = makeHarness();
    await harness.press();
    harness.ready();
    harness.handlers!.onClosed({} as AsrCloseInfo);
    expect(harness.machine.getState().toast?.message).toContain('按实际用量结算');
  });
});

describe('connect 返回晚于本地取消（孤儿 socket 收口）', () => {
  test('按压期间已松开 → connect 返回的会话立即 close', async () => {
    const clock = makeFakeClock();
    const deferred: { resolve: ((session: AsrSessionLike) => void) | null } = { resolve: null };
    let closeCalls = 0;
    const deferredSession: AsrSessionLike = {
      get readyInfo() {
        return null;
      },
      sendAudioBytes() {},
      sendAudioBase64() {},
      finish() {},
      cancel() {},
      close() {
        closeCalls += 1;
      },
    };
    const machine = createPressToTalkMachine({
      recorder: { start: async () => undefined, stop: () => undefined, running: false },
      connect: () =>
        new Promise<AsrSessionLike>((resolve) => {
          deferred.resolve = resolve;
        }),
      postProcess: async (text) => ({ processedText: text }),
      onSend: () => undefined,
      now: clock.now,
      timers: clock.timers,
    });
    machine.pressStart();
    await flushMicrotasks(2);
    expect(machine.getState().phase).toBe('recording');
    machine.pressEnd(); // 握手未完成即松开 → 本地取消收口
    expect(machine.getState().phase).toBe('cancelled');
    expect(machine.getState().toast?.message).toBe('已取消，预扣积分将退回');
    deferred.resolve?.(deferredSession); // 迟到的 connect 结果
    await flushMicrotasks(4);
    expect(closeCalls).toBe(1); // 孤儿 socket 被关闭，不悬挂
  });
});

// ---------------------------------------------------------------------------
// React #185 回归：getSnapshot 引用稳定（useSyncExternalStore 契约）
// ---------------------------------------------------------------------------

describe('getState 快照引用稳定（React #185 回归）', () => {
  test('同一 patch 周期内 getState 返回同一引用；patch 后换新引用', async () => {
    const harness = makeHarness();
    const first = harness.machine.getState();
    expect(harness.machine.getState()).toBe(first); // 未变化 → 缓存引用
    await harness.press(); // patch 发生（phase: recording）
    const second = harness.machine.getState();
    expect(second).not.toBe(first);
    expect(second.phase).toBe('recording');
    expect(harness.machine.getState()).toBe(second); // 再次稳定
  });

  test('subscribe 监听器在 patch 时被通知（useSyncExternalStore 数据源契约）', async () => {
    const harness = makeHarness();
    let notifications = 0;
    const unsubscribe = harness.machine.subscribe(() => {
      notifications += 1;
    });
    await harness.press();
    expect(notifications).toBeGreaterThan(0);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 纯函数：wav 容器 / 本地 metering
// ---------------------------------------------------------------------------

describe('wav / metering 纯函数', () => {
  test('encodeWav 生成 44 字节 PCM 头 + 原载荷（16kHz 单声道口径）', () => {
    const pcm = new Uint8Array(16);
    const wav = encodeWav(pcm);
    expect(wav.length).toBe(WAV_HEADER_BYTES + 16);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(view.getUint32(40, true)).toBe(16); // data chunk size
  });

  test('pcmRmsLevel：静音≈0，满幅≈1', () => {
    expect(pcmRmsLevel(new Uint8Array(64))).toBe(0);
    const loud = new Uint8Array(200);
    const view = new DataView(loud.buffer);
    for (let index = 0; index < 100; index += 1) {
      view.setInt16(index * 2, index % 2 === 0 ? 32767 : -32767, true);
    }
    expect(pcmRmsLevel(loud)).toBeGreaterThan(0.9);
  });
});
