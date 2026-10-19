// Voice post-process API (POL-249) — the M2-4 admin contract (POL-248 card):
//   POST /api/voice/post-process { text, lang? }
//     → 200 { processedText, usage:{promptTokens,completionTokens}, provider, mocked }
//     → 503 provider failure → App 降级展示识别原文（智能整理不可用）
//     → 422 over-length text → same degradation
//     → quota errors → same degradation (the raw transcript is always usable).
// The App maps EVERY failure onto the P09-④ degraded preview — never blocks
// sending on post-process problems.

import { apiClient } from './client';

export interface VoicePostProcessResult {
  processedText: string;
  usage: { promptTokens: number; completionTokens: number };
  provider: string;
  mocked: boolean;
}

export type VoicePostProcessApi = (text: string, lang?: string) => Promise<VoicePostProcessResult>;

export function createVoicePostProcessApi(client: Pick<typeof apiClient, 'post'>): VoicePostProcessApi {
  return async (text, lang) => {
    const result = await client.post<VoicePostProcessResult>(
      '/api/voice/post-process',
      lang === undefined ? { text } : { text, lang },
    );
    if (typeof result?.processedText !== 'string') {
      throw new Error('后处理响应缺少 processedText');
    }
    return result;
  };
}

/** App-wide singleton on the shared admin client. */
export const voicePostProcessApi = createVoicePostProcessApi(apiClient);
