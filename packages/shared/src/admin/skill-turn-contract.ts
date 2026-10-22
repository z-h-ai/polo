// GENERATED from polo-admin/src/lib/skill-turns/contract.ts
// Source SHA-256: 54d9502f84391f0924196045a3c9c4a213acd8282c209555d6c6fccbba696110
// Run backend scripts/sync-skill-turn-contract.mjs --client <checkout>; do not edit.

import { z } from "zod";

// Backend authority. Generate the client derivative using
// scripts/sync-skill-turn-contract.mjs; never maintain another wire schema.
export const SKILL_TURN_CONTRACT_VERSION = 1 as const;
const id = z.string().uuid();
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SkillTurnBeginSchema = z.object({
  contractVersion: z.literal(SKILL_TURN_CONTRACT_VERSION),
  turnId: id,
  subjectKind: z.enum(["personal_artifact", "enterprise_instance"]),
  subjectId: id,
  versionId: id,
  checksum,
}).strict();
export const SkillTurnOperationSchema = z.object({
  contractVersion: z.literal(SKILL_TURN_CONTRACT_VERSION), turnId: id,
}).strict();
export const SkillTurnReceiptSchema = z.object({
  contractVersion: z.literal(SKILL_TURN_CONTRACT_VERSION),
  receiptId: id, accountId: id, productSpaceId: id, turnId: id,
  subjectKind: z.enum(["personal_artifact", "enterprise_instance"]),
  subjectId: id, versionId: id, version: z.string().min(1).max(64), checksum,
  state: z.enum(["active", "finished"]),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type SkillTurnBegin = z.infer<typeof SkillTurnBeginSchema>;
export type SkillTurnOperation = z.infer<typeof SkillTurnOperationSchema>;
export type SkillTurnReceipt = z.infer<typeof SkillTurnReceiptSchema>;
