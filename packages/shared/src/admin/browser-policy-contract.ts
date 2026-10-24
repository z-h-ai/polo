// GENERATED from polo-admin/src/lib/new-api/browser-policy.ts
// Source SHA-256: d2d5ddc52a7d21534f8235b06b7263f062775e2a7ec2cb27eee1dc59410f3d78
// Run scripts/sync-browser-policy-contract.mjs --client <checkout>; do not edit.

import { z } from "zod";

export const DEFAULT_BROWSER_DANGEROUS_WORDS = ["save", "delete", "remove", "submit", "confirm", "pay", "checkout", "purchase", "send", "transfer", "保存", "删除", "提交", "确认", "支付", "付款", "购买", "发送", "转账"];
export const browserPolicySchema = z.object({
  version: z.literal(1),
  autoAcceptEnabled: z.boolean(),
  dangerousWords: z.array(z.string().trim().min(1).max(64)).min(1).max(64),
}).strict();
export type BrowserPolicy = z.infer<typeof browserPolicySchema>;
export function defaultBrowserPolicy(): BrowserPolicy {
  return { version: 1, autoAcceptEnabled: false, dangerousWords: [...DEFAULT_BROWSER_DANGEROUS_WORDS] };
}
export const browserPolicyResponseSchema = z.object({
  productSpaceId: z.string().uuid(),
  configVersion: z.string().min(1).max(128),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policy: browserPolicySchema,
}).strict();
export type BrowserPolicyResponse = z.infer<typeof browserPolicyResponseSchema>;
