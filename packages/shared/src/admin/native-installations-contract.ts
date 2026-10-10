// GENERATED from polo-admin/src/lib/native-installations/contract.ts
// Source SHA-256: 03923c62c18b9e30baaa900c19eddd63cc723033f2d197122f7da3487e1b9f87
// Run backend scripts/sync-native-installation-contract.mjs --client <checkout>; do not edit.

import { z } from "zod";

// Authoritative cross-repository wire contract. The Polo consumer is generated
// by sync-native-installation-contract.mjs; do not maintain a second schema.
export const NATIVE_INSTALLATION_CONTRACT_VERSION = 1 as const;
const id = z.string().uuid();
const version = z.string().min(1).max(64);
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const NativeInstallationAdmissionRequestSchema = z.object({
  contractVersion: z.literal(NATIVE_INSTALLATION_CONTRACT_VERSION),
  productSpaceId: id,
  subjectKind: z.enum(["personal_artifact", "enterprise_instance", "creator_skill"]),
  subjectId: id,
  versionId: id.optional(),
  downloadClaimId: id.optional(),
  version,
  checksum,
}).strict().superRefine((input, ctx) => {
  if (input.subjectKind !== "creator_skill" && !input.versionId) {
    ctx.addIssue({ code: "custom", path: ["versionId"], message: "Exact version identity required" });
  }
  if (input.subjectKind === "creator_skill" && !input.downloadClaimId) {
    ctx.addIssue({ code: "custom", path: ["downloadClaimId"], message: "Original download claim required" });
  }
});
export const NativeInstallationAdmissionSchema = z.object({
  contractVersion: z.literal(NATIVE_INSTALLATION_CONTRACT_VERSION),
  admissionId: id, accountId: id, productSpaceId: id,
  subjectKind: z.enum(["personal_artifact", "enterprise_instance"]),
  subjectId: id, versionId: id, version, checksum,
}).strict();
export const NativeInstallationReportSchema = z.object({
  contractVersion: z.literal(NATIVE_INSTALLATION_CONTRACT_VERSION),
  admissionId: id,
  eventId: id,
  // Opaque persisted UUIDs, never hardware identifiers or local paths.
  deviceId: id, partitionId: id,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  observedAt: z.string().datetime({ offset: true }),
  state: z.enum(["installed", "uninstalled", "managed_detached"]),
  installedAdmissionIds: z.array(id).max(64),
  unmappedVersionCount: z.number().int().min(0).max(10000).default(0),
}).strict().superRefine((input, ctx) => {
  if ((input.state === "installed") !== (input.installedAdmissionIds.length + input.unmappedVersionCount > 0)
      || (input.state !== "installed" && input.unmappedVersionCount !== 0)
      || new Set(input.installedAdmissionIds).size !== input.installedAdmissionIds.length) {
    ctx.addIssue({ code: "custom", path: ["installedAdmissionIds"], message: "Installed snapshot must contain distinct exact admissions; terminal states contain none" });
  }
});
export const NativeInstallationReceiptSchema = z.object({
  contractVersion: z.literal(NATIVE_INSTALLATION_CONTRACT_VERSION),
  eventId: id, revision: z.number().int().positive(),
  outcome: z.enum(["accepted", "replayed", "stale"]),
}).strict();
export type NativeInstallationAdmissionRequest = z.infer<typeof NativeInstallationAdmissionRequestSchema>;
export type NativeInstallationAdmission = z.infer<typeof NativeInstallationAdmissionSchema>;
export type NativeInstallationReport = z.infer<typeof NativeInstallationReportSchema>;
export type NativeInstallationReceipt = z.infer<typeof NativeInstallationReceiptSchema>;

export const NativeInstallationObservationSchema = z.object({
  productSpaceId: z.string().uuid(), subjectKind: z.enum(["personal_artifact", "enterprise_instance"]), subjectId: z.string().uuid(),
  deviceId: z.string().uuid(), partitionId: z.string().uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["installed", "uninstalled", "managed_detached"]),
  unmappedVersionCount: z.number().int().min(0).max(10000),
  observedAt: z.string().datetime({ offset: true }), receivedAt: z.string().datetime({ offset: true }),
  versions: z.array(z.object({ id: z.string().uuid(), version: z.string().min(1).max(64), checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()).max(64),
}).strict();
export type NativeInstallationObservation = z.infer<typeof NativeInstallationObservationSchema>;
