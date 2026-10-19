// usePressToTalk (POL-249 card step 1) — the PRD §⑦ 双模式状态机.
//
// Seven phases (PRD §⑦ 交互状态机, STREAM 基线 + FILE 降级):
//
//   idle(待按) --press--> recording(录音中, finger down)
//     recording --first partial--> recognizing(识别中 STREAM 边说边出 | 转写中 FILE)
//     recording/recognizing --release--> (STREAM: end→final) / (FILE: wav+end→SSE 渐进→final)
//     recognizing --asr_final--> postProcessing(后处理中) --ok--> preview(预览)
//                                              └--fail--> preview(④ 降级: 保留原文)
//     preview --发送--> sent(已发送) --auto--> idle
//     preview --取消--> cancelled --auto--> idle
//     recording/recognizing --上滑--> cancelled(已取消, 预扣全退) --auto--> idle
//
// Mode branch: realtimeStreaming comes ONLY from the /asr handshake
// (asr_ready → capability cache); unknown capabilities degrade to FILE
// (保守). No supplier branching in the App.
//
// Billing wiring: press → relay performs quote+prehold(60s) during the WS
// handshake (asr_ready carries preholdId/credits); {cancel} → relay refund;
// {end} → relay settle by metered seconds (asr_final.seconds). The App only
// renders the outcomes (预扣 chip / 全退 toast / 用时Xs·退回Ys) and never
// settles the relay-owned preholdId itself.
//
// The machine is framework-free with injectable clock/timers so bun tests
// drive it directly; usePressToTalk is a thin useSyncExternalStore binding.

import { useEffect, useState, useSyncExternalStore } from 'react';

import type { AsrCloseInfo, AsrMode, AsrSessionHandlers, AsrSessionLike } from './asrSocket';
import { ASR_CLOSE } from './asrSocket';
import type { MicPermissionApi, MicPermissionState, VoiceRecorderLike } from './audioRecorder';
import {
  DEFAULT_MAX_DURATION_SEC,
  NEAR_CAP_WARNING_SEC,
  maxDurationSecOf,
  resolveVoiceMode,
  voiceCapabilityCache,
} from './capabilities';
import { preholdChipLabel, settlementSummary, useVoiceQuotaGate } from './billingClient';
import type { VoiceSettlement } from './billingClient';
import { MAX_AUDIO_BYTES, PcmChunker, encodeWav } from './wav';

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------

/** PRD §⑦ 七态. */
export type VoicePhase =
  | 'idle'
  | 'recording'
  | 'recognizing'
  | 'postProcessing'
  | 'preview'
  | 'sent'
  | 'cancelled';

export type VoiceCancelReason =
  | 'swipe'
  | 'button'
  | 'error'
  | 'insufficient'
  | 'not_quotable'
  | 'connect'
  | 'permission'
  | 'preview';

export type VoiceToastKind = 'info' | 'success' | 'error';

export interface VoiceToast {
  id: number;
  kind: VoiceToastKind;
  message: string;
}

export type PreviewProcessing =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; text: string }
  | { status: 'failed' };

export interface VoiceState {
  phase: VoicePhase;
  /** 当前分支（能力位裁定；握手前保守 FILE）. */
  mode: AsrMode;
  /** asr_ready 已到（预扣生效、分片可上送）. */
  ready: boolean;
  fingerDown: boolean;
  /** 上滑已越过取消阈值（面板「上滑取消」高亮）. */
  swipeArmed: boolean;
  supplier: string | null;
  elapsedSec: number;
  /** 本地 metering 0..1（声波纹/波形驱动，不依赖服务端）. */
  level: number;
  /** STREAM 流式上屏 / FILE SSE 渐进文本（累计快照，按 seq 单调）. */
  partialText: string;
  preholdSeconds: number;
  preholdCredits: number;
  maxDurationSec: number;
  /** 临近上限（剩约 30 秒，橙 chip 提醒）. */
  nearCap: boolean;
  rateCardMock: boolean;
  /** asr_final 转写全文（SSE 累计兜底）. */
  rawText: string;
  settlement: VoiceSettlement | null;
  processing: PreviewProcessing;
  /** 预览正文：true=识别原文，false=结构化（P09 右上一键互切）. */
  showRaw: boolean;
  /** 可编辑草稿（候选规则 v1.6 登记）. */
  draft: string;
  micPermission: MicPermissionState;
  cancelReason: VoiceCancelReason | null;
  toast: VoiceToast | null;
  /** P07 禁按引导面板（余额不足/不可报价）可见. */
  insufficientPanel: boolean;
  /** 麦克风权限被拒引导面板可见. */
  micPanelDismissed: boolean;
  /** 首次使用引导气泡（P06 待按态）. */
  guideVisible: boolean;
}

export interface VoiceSnapshot extends VoiceState {
  /** 「预扣 60s 剩 53s」/「预扣 60s 已用完」. */
  preholdChipLabel: string;
}

/** Gate surface consumed here (the global zustand store fits; tests inject). */
export interface QuotaGateLike {
  getState(): {
    status: 'unknown' | 'checking' | 'ok' | 'insufficient' | 'not_quotable';
    markInsufficient(nowMs: number): void;
    markNotQuotable(nowMs: number): void;
    markAvailable(supplier: string): void;
  };
}

export interface PressToTalkDeps {
  recorder: VoiceRecorderLike;
  /** Opens one /asr session; handlers are wired before asr_ready. */
  connect(handlers: AsrSessionHandlers): Promise<AsrSessionLike>;
  /** POST /api/voice/post-process（admin 代理轻量 LLM）. */
  postProcess(text: string): Promise<{ processedText: string }>;
  /** 发送走 M1-11 sessions 链路（SessionController.send）. */
  onSend(text: string): void;
  quota?: QuotaGateLike;
  permission?: MicPermissionApi;
  now?: () => number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

export interface PressToTalkActions {
  pressStart(): void;
  /** onResponderMove 的纵向位移；越过 -48px 武装上滑取消. */
  pressMove(dyPx: number): void;
  /** onResponderRelease/Terminate —— 上滑=取消，原位=转文字. */
  pressEnd(): void;
  /** P08 转写中「取消」→ 全退回待按. */
  cancelRecognizing(): void;
  sendPreview(): void;
  cancelPreview(): void;
  /** P09 右上：使用原文 ↔ 使用结构化 一键互切. */
  toggleRaw(): void;
  setDraft(text: string): void;
  pressLockedMic(): void;
  closeInsufficientPanel(): void;
  openMicSettings(): void;
  dismissGuide(): void;
  dismissToast(): void;
  /** 原生采集中断/失败（recorder onError 桥接入口）. */
  notifyRecorderError(message: string): void;
  /** Screen unmount — stops capture and tears the session down. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** 上滑取消纵向位移阈值（px）. */
export const SWIPE_UP_CANCEL_PX = 48;
/**
 * STREAM 上送分片目标时长：100ms @ 16kHz s16le mono（=3200B）。relay /asr 每连接
 * 限流 20 msg/s（超限 close 4008，service.ts checkRate）；原生 PCM 回调频率随设备
 * 浮动（可 >20/s），必须经 PcmChunker 合帧后再上送，帧率上界 10 msg/s。
 */
export const STREAM_UPLINK_FRAME_BYTES = 3_200;
/** 松开后等待 asr_final 的兜底（relay finalWait 5s + 一跳余量）. */
export const FINAL_WAIT_TIMEOUT_MS = 15_000;
/** 已取消/已发送 → 待按 自动回落. */
export const CANCELLED_RESET_MS = 1_800;
export const SENT_RESET_MS = 900;
const TOAST_MS = 1_800;
const TICK_MS = 250;

// ---------------------------------------------------------------------------
// 首次使用引导（per-launch 记忆；重启 App 后重新出现）
// ---------------------------------------------------------------------------

let guideSeenInLaunch = false;

/** 本启动周期内是否完成过一次语音发送（引导气泡消失条件之一）. */
export function hasCompletedVoiceThisLaunch(): boolean {
  return guideSeenInLaunch;
}

// ---------------------------------------------------------------------------
// Machine (framework-free — bun tests drive this directly)
// ---------------------------------------------------------------------------

export function createPressToTalkMachine(deps: PressToTalkDeps) {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const quota = deps.quota ?? useVoiceQuotaGate;

  let state: VoiceState = {
    phase: 'idle',
    mode: resolveVoiceMode(voiceCapabilityCache.get()),
    ready: false,
    fingerDown: false,
    swipeArmed: false,
    supplier: null,
    elapsedSec: 0,
    level: 0,
    partialText: '',
    preholdSeconds: 60,
    preholdCredits: 0,
    maxDurationSec: maxDurationSecOf(voiceCapabilityCache.get()),
    nearCap: false,
    rateCardMock: voiceCapabilityCache.get()?.rateCard.mock ?? false,
    rawText: '',
    settlement: null,
    processing: { status: 'idle' },
    showRaw: false,
    draft: '',
    micPermission: 'unknown',
    cancelReason: null,
    toast: null,
    insufficientPanel: false,
    micPanelDismissed: false,
    guideVisible: !guideSeenInLaunch,
  };

  const listeners = new Set<() => void>();
  // useSyncExternalStore 的 getSnapshot 缓存（React #185）: getState 在一次
  // patch 周期内必须返回同一引用——每次新建对象会让 React 判定 store 在渲染间
  // 永远「已变化」→ 'The result of getSnapshot should be cached' 无限重渲染。
  let snapshotCache: VoiceSnapshot | null = null;
  const session = {
    current: null as AsrSessionLike | null,
    gen: 0,
    startedAtMs: 0,
    lastDy: 0,
    pcmChunks: [] as Uint8Array[],
    pcmBytes: 0,
    /** STREAM 上送合帧器（原生回调 → ≤10 帧/s；FILE 模式闲置）. */
    uplink: null as PcmChunker | null,
    lastPartialSeq: 0,
    finalSeen: false,
    localClosed: false,
    tickHandle: null as unknown,
    finalTimeoutHandle: null as unknown,
    resetHandle: null as unknown,
    toastHandle: null as unknown,
    toastSeq: 0,
    /** P09 双槽草稿：原文/结构化各自记忆编辑，互切不丢（候选规则 v1.6）. */
    rawDraft: '',
    structuredDraft: '',
  };

  function patch(partial: Partial<VoiceState>): void {
    state = { ...state, ...partial };
    snapshotCache = null; // 状态已变——失效缓存，下一次 getState 重算
    for (const listener of listeners) listener();
  }

  function snapshot(): VoiceSnapshot {
    if (snapshotCache === null) {
      snapshotCache = {
        ...state,
        preholdChipLabel: preholdChipLabel(state.elapsedSec, state.preholdSeconds),
      };
    }
    return snapshotCache;
  }

  function showToast(message: string, kind: VoiceToastKind = 'info'): void {
    if (session.toastHandle !== null && session.toastHandle !== undefined) {
      timers.clear(session.toastHandle);
    }
    session.toastSeq += 1;
    patch({ toast: { id: session.toastSeq, kind, message } });
    session.toastHandle = timers.set(() => {
      session.toastHandle = null;
      if (state.toast?.id === session.toastSeq) patch({ toast: null });
    }, TOAST_MS);
  }

  // -- timers -----------------------------------------------------------------

  function clearVoiceTimers(): void {
    if (session.tickHandle !== null && session.tickHandle !== undefined) {
      timers.clear(session.tickHandle);
      session.tickHandle = null;
    }
    if (session.finalTimeoutHandle !== null && session.finalTimeoutHandle !== undefined) {
      timers.clear(session.finalTimeoutHandle);
      session.finalTimeoutHandle = null;
    }
  }

  function clearResetTimers(): void {
    if (session.resetHandle !== null && session.resetHandle !== undefined) {
      timers.clear(session.resetHandle);
      session.resetHandle = null;
    }
  }

  function startTick(): void {
    if (session.tickHandle !== null && session.tickHandle !== undefined) return;
    const tick = () => {
      session.tickHandle = null;
      const elapsed = Math.max(0, Math.round((now() - session.startedAtMs) / 1000));
      const nearCap = state.fingerDown && elapsed >= state.maxDurationSec - NEAR_CAP_WARNING_SEC;
      if (elapsed !== state.elapsedSec || nearCap !== state.nearCap) {
        patch({ elapsedSec: elapsed, nearCap });
      }
      // 到顶自动停止（PRD §⑦: 视同松开 + toast）——仅按住期间生效.
      if (state.fingerDown && elapsed >= state.maxDurationSec) {
        showToast('已达单次最长 5 分钟，已自动停止并转入文字', 'info');
        releaseAndFinish();
        return;
      }
      session.tickHandle = timers.set(tick, TICK_MS);
    };
    session.tickHandle = timers.set(tick, TICK_MS);
  }

  // -- session lifecycle --------------------------------------------------------

  /** Per-generation /asr frame handlers (stale generations are ignored). */
  function sessionHandlers(gen: number): AsrSessionHandlers {
    const stale = () => gen !== session.gen || session.localClosed;
    return {
      onReady(info) {
        if (stale()) return;
        if (state.phase !== 'recording' && state.phase !== 'recognizing') return;
        voiceCapabilityCache.update(info, now());
        quota.getState().markAvailable(info.supplier);
        patch({
          ready: true,
          supplier: info.supplier,
          mode: info.realtimeStreaming ? 'STREAM' : 'FILE',
          maxDurationSec: info.maxDurationSec > 0 ? info.maxDurationSec : DEFAULT_MAX_DURATION_SEC,
          preholdSeconds: info.preholdSeconds > 0 ? info.preholdSeconds : 60,
          preholdCredits: info.preholdCredits,
          rateCardMock: info.rateCard.mock,
        });
        // 预扣生效瞬间补齐握手窗口内已采到的音频（STREAM 口径）.
        if (info.realtimeStreaming) drainPcmToStream();
      },
      onPartial(text, seq) {
        if (stale()) return;
        if (state.phase !== 'recording' && state.phase !== 'recognizing') return;
        if (seq <= session.lastPartialSeq) return; // 累计快照按 seq 单调
        session.lastPartialSeq = seq;
        // STREAM: 按住中首个 partial → 识别中（边说边出）; FILE: 松开后 SSE 渐进.
        patch({ phase: 'recognizing', partialText: text });
      },
      onFinal(text, seconds) {
        if (stale() || session.finalSeen) return;
        session.finalSeen = true;
        if (session.finalTimeoutHandle !== null && session.finalTimeoutHandle !== undefined) {
          timers.clear(session.finalTimeoutHandle);
          session.finalTimeoutHandle = null;
        }
        // relay finalWait 收口可能发出空文本 final —— SSE 累计兜底.
        const transcript = text.length > 0 ? text : state.partialText;
        const settlement = settlementSummary(seconds, state.preholdSeconds);
        patch({
          rawText: transcript,
          settlement,
          partialText: '',
          level: 0,
          phase: 'postProcessing',
          processing: { status: 'loading' },
        });
        void runPostProcess(transcript, gen);
      },
      onError(code, message) {
        if (stale()) return;
        if (code === 'max_duration_reached') return; // 预期提醒：本地到顶已自停
        if (code === 'insufficient_balance') {
          quota.getState().markInsufficient(now());
          failVoice('语音积分不足，请充值后再使用', 'insufficient');
          return;
        }
        if (code === 'not_quotable') {
          quota.getState().markNotQuotable(now());
          failVoice('语音服务暂不可用', 'not_quotable');
          return;
        }
        // 措辞与 relay 结算语义严格对齐（service.ts 是权威）：
        //   upstream_error → relay refund 全退（异步在途 → 「将」不夸大为「已」）；
        //   session_timeout(4502) → relay 按实测秒 settle 收口，并非全退；
        //   其余 pre-ready 失败（供应商/计费不可用）→ 未生效预扣，无退款可言。
        if (code === 'session_timeout') {
          failVoice('已达单次会话时长上限，本次已按实际用时结算', 'error');
          return;
        }
        if (code === 'upstream_error') {
          failVoice('转写失败，本次预扣积分将全额退回。请检查网络后再按住说话。', 'error');
          return;
        }
        failVoice(`语音服务出错（${message || code}），请稍后再试`, 'error');
      },
      onClosed(info: AsrCloseInfo) {
        if (stale()) return;
        // 正常收口（final→postProcessing、cancel→cancelled）不经过这里.
        if (state.phase !== 'recording' && state.phase !== 'recognizing') return;
        if (info.code === ASR_CLOSE.INSUFFICIENT_BALANCE) {
          quota.getState().markInsufficient(now());
          failVoice('语音积分不足，请充值后再使用', 'insufficient');
          return;
        }
        if (info.code === ASR_CLOSE.NOT_QUOTABLE) {
          quota.getState().markNotQuotable(now());
          failVoice('语音服务暂不可用', 'not_quotable');
          return;
        }
        if (info.code === ASR_CLOSE.UNAUTHORIZED) {
          // 4401 只发生在 pre-ready（升级/计费鉴权拒）——预扣未生效，无退款可言。
          failVoice('语音登录已过期，请重新登录后再使用语音', 'error');
          return;
        }
        // 断连（含 4500/4502/4008/网络掉线）：relay handleClose 按服务端实测秒
        // settle 收口（0 秒才全退）——不能宣称「将全额退回」。
        failVoice('语音连接中断，本次预扣积分将按实际用量结算', 'connect');
      },
    };
  }

  async function runPostProcess(text: string, gen: number): Promise<void> {
    try {
      const result = await deps.postProcess(text);
      if (gen !== session.gen) return;
      const structured = result.processedText.trim().length > 0 ? result.processedText : text;
      session.structuredDraft = structured;
      session.rawDraft = text;
      patch({
        phase: 'preview',
        processing: { status: 'done', text: structured },
        showRaw: false,
        draft: structured,
      });
    } catch {
      if (gen !== session.gen) return;
      // P09 ④: 后处理失败 → 保留识别原文并提示，可直接编辑/发送.
      session.structuredDraft = text;
      session.rawDraft = text;
      patch({
        phase: 'preview',
        processing: { status: 'failed' },
        showRaw: true,
        draft: text,
      });
    }
  }

  function releaseSessionLocal(): void {
    session.localClosed = true;
    session.current?.close();
    session.current = null;
  }

  function stopRecorder(): void {
    try {
      deps.recorder.stop();
    } catch {
      // recorder failures never block the state machine
    }
  }

  /** 终态失败：面板关闭回待按 + 全退提示（relay refund 收口）. */
  function failVoice(message: string, reason: VoiceCancelReason): void {
    clearVoiceTimers();
    stopRecorder();
    releaseSessionLocal();
    session.pcmChunks = [];
    session.pcmBytes = 0;
    patch({
      phase: 'cancelled',
      cancelReason: reason,
      fingerDown: false,
      swipeArmed: false,
      ready: false,
      level: 0,
      partialText: '',
      toast: null,
    });
    showToast(message, 'error');
    armAutoIdle(CANCELLED_RESET_MS);
  }

  function armAutoIdle(delayMs: number): void {
    clearResetTimers();
    const gen = session.gen;
    session.resetHandle = timers.set(() => {
      session.resetHandle = null;
      if (gen !== session.gen) return;
      patch({ phase: 'idle', cancelReason: null, processing: { status: 'idle' } });
    }, delayMs);
  }

  // -- PCM plumbing -------------------------------------------------------------

  function acceptPcm(bytes: Uint8Array, level?: number): void {
    if (state.phase !== 'recording' && state.phase !== 'recognizing') return;
    if (session.pcmBytes < MAX_AUDIO_BYTES) {
      // ≈5 分钟上限的硬闸（10MB，与 relay MiMo 口径一致）.
      session.pcmChunks.push(bytes);
      session.pcmBytes += bytes.length;
    }
    if (state.mode === 'STREAM' && state.ready) {
      // 经合帧器上送（relay 20 msg/s 限流；握手窗口内的积压由 drainPcmToStream 补发）.
      session.uplink?.push(bytes);
    }
    if (level !== undefined) patch({ level });
  }

  /** asr_ready 生效瞬间：把握手窗口内已采到的音频按序补发（STREAM 口径）. */
  function drainPcmToStream(): void {
    const uplink = session.uplink;
    if (!uplink) return;
    for (const chunk of session.pcmChunks) uplink.push(chunk);
    session.pcmChunks = [];
    uplink.end(); // 冲出 <100ms 的尾帧
  }

  // -- actions ------------------------------------------------------------------

  function pressStart(): void {
    if (state.phase !== 'idle') return;
    clearResetTimers();

    // P07 余额不足禁按：置灰+锁，按压打开引导面板（去充值/积分规则）.
    const gateStatus = quota.getState().status;
    if (gateStatus === 'insufficient' || gateStatus === 'not_quotable') {
      patch({ insufficientPanel: true });
      return;
    }

    // 下一代会话.
    session.gen += 1;
    const gen = session.gen;
    session.finalSeen = false;
    session.lastPartialSeq = 0;
    session.localClosed = false;
    session.pcmChunks = [];
    session.pcmBytes = 0;
    session.lastDy = 0;
    session.current = null;
    session.uplink = new PcmChunker(STREAM_UPLINK_FRAME_BYTES, (pcm) => {
      // flush 时机晚于会话切换也安全：sendAudioBytes 在 socket 关闭后 no-op。
      session.current?.sendAudioBytes(pcm);
    });
    session.rawDraft = '';
    session.structuredDraft = '';

    const begin = async () => {
      // 麦克风权限三态（未请求→请求 / 已授权 / 被拒→应用内引导+系统设置）.
      if (deps.permission) {
        try {
          const permission = await deps.permission.ensure();
          if (gen !== session.gen) return;
          patch({ micPermission: permission, micPanelDismissed: false });
          if (permission !== 'granted') return;
        } catch {
          // 探测失败不阻断——交给 recorder.start 的错误路径
        }
      }
      try {
        await deps.recorder.start();
      } catch {
        if (gen !== session.gen) return;
        failVoice('麦克风启动失败，请检查权限后重试', 'permission');
        return;
      }
      if (gen !== session.gen) {
        stopRecorder();
        return;
      }
      session.startedAtMs = now();
      patch({
        phase: 'recording',
        fingerDown: true,
        swipeArmed: false,
        ready: false,
        elapsedSec: 0,
        level: 0,
        partialText: '',
        rawText: '',
        settlement: null,
        processing: { status: 'idle' },
        showRaw: false,
        draft: '',
        cancelReason: null,
        mode: resolveVoiceMode(voiceCapabilityCache.get()),
        maxDurationSec: maxDurationSecOf(voiceCapabilityCache.get()),
        preholdSeconds: 60,
        preholdCredits: 0,
      });
      startTick();
      try {
        const opened = await deps.connect(sessionHandlers(gen));
        // 连接期间用户已松开/取消（pressEnd 走 cancelVoice）：关闭孤儿 socket.
        if (gen !== session.gen || session.localClosed) {
          opened.close();
          return;
        }
        session.current = opened;
        if (state.mode === 'STREAM' && state.ready) drainPcmToStream();
      } catch (error) {
        // 已换代（重新按住）：不碰新一代会话.
        if (gen !== session.gen) return;
        // onerror 帧已收口过本次按压（如 insufficient_balance 后随 4402 close）——
        // 不覆盖更精确的终态 toast.
        if (state.phase !== 'recording' && state.phase !== 'recognizing') return;
        const code = (error as { code?: string }).code;
        if (code === 'insufficient_balance') {
          quota.getState().markInsufficient(now());
          failVoice('语音积分不足，请充值后再使用', 'insufficient');
          return;
        }
        if (code === 'not_quotable') {
          quota.getState().markNotQuotable(now());
          failVoice('语音服务暂不可用', 'not_quotable');
          return;
        }
        failVoice('语音连接失败，请检查网络后再按住说话', 'connect');
      }
    };
    void begin();
  }

  function pressMove(dyPx: number): void {
    session.lastDy = dyPx;
    const armed = dyPx <= -SWIPE_UP_CANCEL_PX;
    if (armed !== state.swipeArmed) patch({ swipeArmed: armed });
  }

  function pressEnd(): void {
    if (!state.fingerDown) return;
    const swipe = state.swipeArmed || session.lastDy <= -SWIPE_UP_CANCEL_PX;
    if (swipe) {
      // 上滑取消 → relay refund 全退（PRD §⑦ / 卡：已取消，预扣积分将退回）.
      cancelVoice('swipe', '已取消，预扣积分将退回');
      return;
    }
    releaseAndFinish();
  }

  function cancelVoice(reason: VoiceCancelReason, toast: string): void {
    clearVoiceTimers();
    // {type:"cancel"} → relay refund 全退并收口.
    try {
      session.current?.cancel();
    } catch {
      // wire gone — the close path settles
    }
    releaseSessionLocal();
    stopRecorder();
    session.pcmChunks = [];
    session.pcmBytes = 0;
    patch({
      phase: 'cancelled',
      cancelReason: reason,
      fingerDown: false,
      swipeArmed: false,
      ready: false,
      level: 0,
      partialText: '',
      toast: null,
    });
    showToast(toast, 'info');
    armAutoIdle(CANCELLED_RESET_MS);
  }

  /** 松开 / 到顶自动停止（视同松开）→ 上送收尾 → 转写中. */
  function releaseAndFinish(): void {
    const current = session.current;
    if (!current || !state.ready) {
      // 握手未完成即松开：relay 0 秒全退口径，直接回待按.
      cancelVoice('button', '已取消，预扣积分将退回');
      return;
    }
    clearVoiceTimers();
    stopRecorder();
    if (state.mode === 'FILE') {
      // FILE：本地攒段 → wav 容器整段上送（16kHz 16bit 单声道，≤10MB）.
      const merged = new Uint8Array(session.pcmBytes);
      let offset = 0;
      for (const chunk of session.pcmChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      if (merged.length === 0) {
        cancelVoice('button', '已取消，预扣积分将退回');
        return;
      }
      current.sendAudioBytes(encodeWav(merged));
      session.pcmChunks = [];
      session.pcmBytes = 0;
    } else {
      // STREAM：冲出合帧器尾帧再 end，保证尾部音频进入计量.
      session.uplink?.end();
    }
    current.finish(); // {type:"end"} → relay 收尾 → asr_final（按实测秒结算）
    patch({ phase: 'recognizing', fingerDown: false, swipeArmed: false, level: 0 });
    const gen = session.gen;
    session.finalTimeoutHandle = timers.set(() => {
      session.finalTimeoutHandle = null;
      if (gen !== session.gen || session.finalSeen) return;
      failVoice('转写超时，本次预扣积分将全额退回', 'error');
    }, FINAL_WAIT_TIMEOUT_MS);
  }

  // -- preview / send ------------------------------------------------------------

  function sendPreview(): void {
    if (state.phase !== 'preview') return;
    const text = state.draft.trim();
    if (!text) return;
    guideSeenInLaunch = true;
    deps.onSend(text);
    patch({ phase: 'sent', toast: null });
    armAutoIdle(SENT_RESET_MS);
  }

  function cancelPreview(): void {
    if (state.phase !== 'preview' && state.phase !== 'postProcessing') return;
    // 计费已在 asr_final 时按实测秒结算（settle 提示见预览 okbar）.
    clearVoiceTimers();
    releaseSessionLocal();
    patch({ phase: 'cancelled', cancelReason: 'preview', toast: null });
    showToast('已取消');
    armAutoIdle(CANCELLED_RESET_MS);
  }

  function cancelRecognizing(): void {
    if (state.phase !== 'recognizing' && state.phase !== 'recording') return;
    cancelVoice('button', '已取消，预扣积分将退回');
  }

  function toggleRaw(): void {
    if (state.phase !== 'preview') return;
    if (state.processing.status !== 'done') return; // 失败态只有原文
    // 互切不丢编辑：先把当前稿存回其来源槽，再取另一来源槽（含用户编辑）.
    if (state.showRaw) session.rawDraft = state.draft;
    else session.structuredDraft = state.draft;
    const showRaw = !state.showRaw;
    patch({
      showRaw,
      draft: showRaw ? session.rawDraft : session.structuredDraft,
    });
  }

  function setDraft(text: string): void {
    if (state.phase !== 'preview') return;
    if (state.showRaw) session.rawDraft = text;
    else session.structuredDraft = text;
    patch({ draft: text });
  }

  function pressLockedMic(): void {
    const status = quota.getState().status;
    patch({ insufficientPanel: status === 'insufficient' || status === 'not_quotable' });
  }

  function closeInsufficientPanel(): void {
    // 关闭任一引导面板（禁按 / 权限被拒共用关闭入口）.
    patch({ insufficientPanel: false, micPanelDismissed: true });
  }

  function openMicSettings(): void {
    deps.permission?.openSettings();
  }

  function notifyRecorderError(message: string): void {
    if (state.phase !== 'recording' && state.phase !== 'recognizing') return;
    // 本地关闭后 relay handleClose 按实测秒 settle（0 秒全退）——措辞同断连口径。
    failVoice(`麦克风异常（${message}），本次预扣积分将按实际用量结算`, 'error');
  }

  function dismissGuide(): void {
    guideSeenInLaunch = true;
    patch({ guideVisible: false });
  }

  function dismissToast(): void {
    if (session.toastHandle !== null && session.toastHandle !== undefined) {
      timers.clear(session.toastHandle);
      session.toastHandle = null;
    }
    patch({ toast: null });
  }

  function dispose(): void {
    session.gen += 1;
    session.uplink = null;
    clearVoiceTimers();
    clearResetTimers();
    if (session.toastHandle !== null && session.toastHandle !== undefined) {
      timers.clear(session.toastHandle);
      session.toastHandle = null;
    }
    releaseSessionLocal();
    stopRecorder();
    patch({ phase: 'idle', fingerDown: false, level: 0 });
  }

  return {
    getState: snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pressStart,
    pressMove,
    pressEnd,
    cancelRecognizing,
    sendPreview,
    cancelPreview,
    toggleRaw,
    setDraft,
    pressLockedMic,
    closeInsufficientPanel,
    openMicSettings,
    dismissGuide,
    dismissToast,
    notifyRecorderError,
    dispose,
    /** 测试钩子：直驱 asr 帧（绕过 socket，当前代 handlers）. */
    __handlers(): AsrSessionHandlers {
      return sessionHandlers(session.gen);
    },
    /** 测试/装配钩子：喂 PCM + metering（绕过 recorder）. */
    __feedPcm(bytes: Uint8Array, level?: number): void {
      acceptPcm(bytes, level);
    },
    /** 装配钩子：metering 单独喂入（声波纹驱动）. */
    __setLevel(level: number): void {
      if (state.phase !== 'recording' && state.phase !== 'recognizing') return;
      // 原生回调可达每秒数十次：阈值门限压 re-render 频率，不阻塞 JS 线程.
      if (Math.abs(level - state.level) < 0.02) return;
      patch({ level });
    },
    /** 测试钩子：观察本地 PCM 累计字节数. */
    __pcmBytes(): number {
      return session.pcmBytes;
    },
  };
}

export type PressToTalkMachine = ReturnType<typeof createPressToTalkMachine>;

// ---------------------------------------------------------------------------
// React binding (thin — machine instance lives for the screen's lifetime)
// ---------------------------------------------------------------------------

export function usePressToTalk(deps: PressToTalkDeps): PressToTalkMachine {
  const [machine] = useState(() => createPressToTalkMachine(deps));
  // getState 必须返回缓存快照（patch 时失效）——见 machine 内 snapshotCache 注释。
  useSyncExternalStore(machine.subscribe, machine.getState, machine.getState);
  useEffect(() => () => machine.dispose(), [machine]);
  return machine;
}
