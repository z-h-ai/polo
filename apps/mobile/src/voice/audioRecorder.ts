// Microphone capture layer (POL-24 card step 2) over expo-audio SDK 58.
//
// One AudioStream per 按住 session (16kHz s16le mono — the relay /asr uplink
// contract, packages/relay/src/asr/types.ts:35):
//   - onBuffer delivers raw PCM chunks live → STREAM 分片上送 + local metering
//     (PRD §⑦: 声波纹由本地 metering 驱动，不依赖服务端);
//   - the same chunks accumulate App-side; on release they are wrapped into a
//     wav container (encodeWav) for the FILE 整段上送 (MiMo magic-byte sniffing).
//
// Permission three-state (未请求/已授权/被拒 → 应用内引导 + 系统设置, UX-7):
// ensureMicrophonePermission() resolves 'granted' | 'denied'; the hook maps
// 'denied' onto an in-app guidance panel that deep-links to system settings.
//
// The expo-audio Touch is isolated behind VoiceRecorderLike so the state
// machine (usePressToTalk) and its tests run on fakes with zero native mocks.

import type { AudioStreamResult } from 'expo-audio';

import { PCM_SAMPLE_RATE, pcmRmsLevel } from './wav';

// ---------------------------------------------------------------------------
// Injectable surface (consumed by usePressToTalk; tests provide fakes)
// ---------------------------------------------------------------------------

/** One live PCM chunk from the microphone (s16le little-endian, mono). */
export interface PcmChunk {
  bytes: Uint8Array;
  /** Actual capture sample rate (Hz) — informational; uplink is 16k. */
  sampleRate: number;
  /** Seconds since stream start. */
  timestamp: number;
}

export interface VoiceRecorderHandlers {
  onChunk(chunk: PcmChunk): void;
  /** 0..1 local RMS level per chunk — drives the wave animation. */
  onLevel(level: number): void;
  /** Native capture died mid-press (interrupt/permission revoked). */
  onError(message: string): void;
}

export interface VoiceRecorderLike {
  /** Starts capture; resolves once the mic is live. */
  start(): Promise<void>;
  /** Stops capture and releases native resources (best effort, never throws). */
  stop(): void;
  readonly running: boolean;
}

export type MicPermissionState = 'unknown' | 'granted' | 'denied';

export interface MicPermissionApi {
  /** Undetermined → asks; denied stays denied; granted → granted. */
  ensure(): Promise<MicPermissionState>;
  /** Opens the OS settings page for the denied guidance panel. */
  openSettings(): void;
}

// ---------------------------------------------------------------------------
// expo-audio adapters (app wiring; never imported by tests)
// ---------------------------------------------------------------------------

interface AudioStreamLike {
  readonly isStreaming: boolean;
  start(): Promise<void>;
  stop(): void;
}

/**
 * Bridges the expo-audio AudioStream (a per-mount SharedObject) onto the
 * VoiceRecorderLike surface. PCM buffers flow through the useAudioStream
 * onBuffer → pump path (wired in the screen); this adapter only drives
 * start/stop and forwards native capture failures.
 */
export function createStreamRecorder(
  stream: AudioStreamLike,
  onError?: (message: string) => void,
): VoiceRecorderLike {
  return {
    get running() {
      return stream.isStreaming;
    },
    async start() {
      if (!stream.isStreaming) await stream.start();
    },
    stop() {
      try {
        if (stream.isStreaming) stream.stop();
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Hook-side PCM → {chunk, level} bridge; drops silent empty buffers. */
export function makeBufferPump(handlers: Pick<VoiceRecorderHandlers, 'onChunk' | 'onLevel'>): (data: ArrayBuffer, sampleRate: number, timestamp: number) => void {
  return (data, sampleRate, timestamp) => {
    const bytes = new Uint8Array(data);
    if (bytes.length === 0) return;
    handlers.onLevel(pcmRmsLevel(bytes));
    handlers.onChunk({ bytes, sampleRate, timestamp });
  };
}

/** expo-audio options shared by the panel's useAudioStream call. */
export const voiceAudioStreamOptions = {
  sampleRate: PCM_SAMPLE_RATE,
  channels: 1,
  encoding: 'int16' as const,
};

// -- permission ---------------------------------------------------------------

export function createMicPermissionApi(module: {
  requestRecordingPermissionsAsync: () => Promise<{ granted: boolean; status: string; canAskAgain?: boolean }>;
  getRecordingPermissionsAsync: () => Promise<{ granted: boolean; status: string; canAskAgain?: boolean }>;
  openSettings: () => void;
}): MicPermissionApi {
  return {
    async ensure() {
      const current = await module.getRecordingPermissionsAsync();
      if (current.granted) return 'granted';
      if (current.status === 'undetermined' || current.canAskAgain !== false) {
        const asked = await module.requestRecordingPermissionsAsync();
        return asked.granted ? 'granted' : 'denied';
      }
      return 'denied';
    },
    openSettings() {
      module.openSettings();
    },
  };
}

/** Type re-export so the panel can wire useAudioStream without leaking types. */
export type { AudioStreamResult };
