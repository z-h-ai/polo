// Pure audio helpers for the POL-249 voice flow — no React, no expo-audio, no
// network. Everything here is unit-testable under bun test.
//
// Wire alignment (verified against packages/relay/src/asr — relay is the
// contract source, App adapts):
//   - Upstream audio contract is 16kHz s16le mono PCM (ASR_PCM_SAMPLE_RATE /
//     ASR_PCM_BYTES_PER_SEC, types.ts:35). STREAM pushes raw PCM chunks
//     (binary WS frames == audio chunks, service.ts:303); FILE wants a wav
//     container (MiMo adapter magic-byte sniffing, mimo-adapter.ts) with the
//     same 10MB cap (MIMO_MAX_AUDIO_BYTES).

/** PRD §⑦ / relay 上行口径：16kHz s16le mono。 */
export const PCM_SAMPLE_RATE = 16_000;
/** 16kHz × 2 bytes/sample（s16le mono，与 relay ASR_PCM_BYTES_PER_SEC 一致）。 */
export const PCM_BYTES_PER_SEC = PCM_SAMPLE_RATE * 2;
/** MiMo 文档上限：Base64 前的原始音频字节数（relay MIMO_MAX_AUDIO_BYTES）。 */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
/** 标准 PCM wav 头长度（RIFF/ fmt / data 四个 chunk）。 */
export const WAV_HEADER_BYTES = 44;

/** Standard 44-byte PCM wav header (RIFF → WAVE → fmt(16, PCM) → data). */
export function encodeWavHeader(pcmBytes: number, sampleRate: number, channels = 1): Uint8Array {
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const byteRate = sampleRate * channels * 2; // s16le
  const blockAlign = channels * 2;

  writeAscii(header, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  writeAscii(header, 8, 'WAVE');
  writeAscii(header, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(header, 36, 'data');
  view.setUint32(40, pcmBytes, true);
  return header;
}

/** Raw s16le mono PCM → complete wav container (44-byte header + payload). */
export function encodeWav(pcm: Uint8Array, sampleRate = PCM_SAMPLE_RATE, channels = 1): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
  out.set(encodeWavHeader(pcm.length, sampleRate, channels), 0);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

/**
 * Local metering for the 声波纹/波形 (PRD §⑦: 本地 metering 驱动，不依赖服务端).
 * RMS of s16le little-endian samples → linear 0..1.
 */
export function pcmRmsLevel(pcm: Uint8Array): number {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true);
    sumSquares += (sample / 32768) * (sample / 32768);
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/** Maps a linear RMS level onto the 0..1 bar-height curve (perceptual lift). */
export function levelToBars(level: number, bars: number): number[] {
  // Slight gamma lift so speech sits mid-scale; silence still collapses to 0.
  const shaped = Math.min(1, Math.pow(Math.max(0, level) * 3.2, 0.6));
  // Deterministic per-bar jitter so the wave reads as motion even with a
  // constant tone — derived from the level itself, no RNG.
  return Array.from({ length: bars }, (_, index) => {
    const wave = 0.75 + 0.25 * Math.sin(index * 1.7 + level * 12.6);
    return Math.max(0.08, Math.min(1, shaped * wave));
  });
}

/**
 * Batches arbitrary-size PCM chunks into ~fixed-duration audio frames for the
 * STREAM uplink (relay accepts any chunk size; batching bounds WS frame rate).
 */
export class PcmChunker {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly targetBytes: number,
    private readonly flush: (pcm: Uint8Array) => void,
    private readonly maxBytes = MAX_AUDIO_BYTES,
  ) {}

  push(chunk: Uint8Array): void {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= this.targetBytes) this.drain();
  }

  /** Flushes the remainder (松开/到顶收尾). */
  end(): void {
    if (this.pendingBytes === 0) return;
    this.drain();
  }

  /** Total PCM bytes accepted so far (FILE 的 10MB 闸也用它看齐). */
  get acceptedBytes(): number {
    return this.accepted;
  }

  private accepted = 0;

  private drain(): void {
    if (this.pendingBytes === 0) return;
    const merged = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const part of this.pending) {
      merged.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    if (this.accepted + merged.length > this.maxBytes) {
      const room = Math.max(0, this.maxBytes - this.accepted);
      this.accepted = this.maxBytes;
      if (room === 0) return;
      this.flush(merged.subarray(0, room));
      return;
    }
    this.accepted += merged.length;
    this.flush(merged);
  }
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index);
  }
}

/** ArrayBuffer/Uint8Array → base64 (Buffer is a declared mobile dependency). */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
