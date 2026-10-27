/**
 * U3 (product-closure 2026-10-27) — batch operations report REAL counts.
 *
 * The old batch menu swallowed every per-item failure (`.catch(() => {})`)
 * and then toasted an unconditional "已删除 N 个" — a full-failure run read
 * exactly like a full success. This module runs the items sequentially
 * (matcher-index order matters to the callers), collects honest counts, and
 * maps them onto one of three outcomes: full success, partial ("成功 X /
 * 失败 Y"), or total failure (an error — never a success-shaped copy).
 */
import { i18n } from '@polo-ai/shared/i18n'
import { toast } from 'sonner'

export interface BatchOpCounts {
  ok: number
  failed: number
}

/**
 * Run `op` over `items` sequentially (callers pass the item order they
 * need), collecting per-item outcomes instead of swallowing them.
 */
export async function runBatchOp<T>(items: readonly T[], op: (item: T) => Promise<unknown>): Promise<BatchOpCounts> {
  let ok = 0
  let failed = 0
  for (const item of items) {
    try {
      await op(item)
      ok += 1
    } catch {
      failed += 1
    }
  }
  return { ok, failed }
}

export type BatchResultToastKind = 'success' | 'error' | 'warning'

export interface BatchResultPresentation {
  toast: BatchResultToastKind
  messageKey: string
  params: Record<string, number>
}

/**
 * U3 presentation matrix — full success keeps the existing pluralized
 * "已<verb> {{count}} 个" copy; anything with a failure speaks in counts and
 * a total failure never wears success wording.
 */
export function presentBatchResult(
  counts: BatchOpCounts,
  keys: { allSuccessKey: string; partialKey: string; allFailedKey: string },
): BatchResultPresentation {
  if (counts.failed === 0) {
    return { toast: 'success', messageKey: keys.allSuccessKey, params: { count: counts.ok } }
  }
  if (counts.ok === 0) {
    return { toast: 'error', messageKey: keys.allFailedKey, params: { failed: counts.failed } }
  }
  return {
    toast: 'warning',
    messageKey: keys.partialKey,
    params: { ok: counts.ok, fail: counts.failed },
  }
}

/** Toast the presented result (sonner has no `warning`; map it to `message`). */
export function showBatchResultToast(presentation: BatchResultPresentation): void {
  const payload = { duration: 5000 }
  if (presentation.toast === 'success') toast.success(i18n.t(presentation.messageKey, presentation.params), payload)
  else if (presentation.toast === 'error') toast.error(i18n.t(presentation.messageKey, presentation.params), payload)
  else toast.message(i18n.t(presentation.messageKey, presentation.params), payload)
}
