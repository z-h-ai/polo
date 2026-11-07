// GENERATED FILE — do not edit by hand.
// Source of truth: polo-admin `src/lib/enterprises/client-contracts.ts` and the
// CLIENT-CONTRACT block of `src/lib/enterprises/create-presentation.ts`.
// Contract: poo196-client-enterprise-r3 · contracts sha256: 98b8703995f38d342bd66f3f3a382a415babc5050f0bc6f9fef22bd243562626 · presentation sha256: 929fc0b70fd2189a359a3f84be82478ec8135458121c30ebd8ea6c883acc7d1c
// Regenerate: `tsx scripts/export-client-enterprise-contract.ts <this-file>` (polo-admin repo);
// `--check` verifies no drift between the two repos.
import { z } from 'zod'

/**
 * POO-196 client enterprise contract — HTTP DTOs, masked read models and the
 * stable error codes for the narrow client Bearer surface (adjudication
 * D-A/D-B/D-C). This module is the source of truth for BOTH ends: admin
 * routes validate with it and `scripts/export-client-enterprise-contract.ts`
 * transforms it into the Polo client's
 * `packages/shared/src/admin/client-enterprise-contract.ts`. Rules that keep
 * the transform honest:
 *
 * - self-contained: `zod` is the ONLY import; no Prisma, no admin runtime
 *   types, no `@/` aliases;
 * - wire-neutral: no cookie, bearer, tokenHash or storage vocabulary appears
 *   in any identifier or error code the transform copies;
 * - every object schema is `.strict()` — an unknown field is a contract
 *   breach, not an extension point;
 * - identity (user id, jti, accountKind, enterprise id, role) is never a
 *   body field: it comes from the verified session.
 */

export const CLIENT_ENTERPRISE_CONTRACT_VERSION = "poo196-client-enterprise-r3";

/** POO-196 R3 (D7): the previous wire version. A request without a
 * negotiation header is still validated and fingerprinted as r2 — the r3
 * capabilities (optional purpose, versioned fingerprint domain) are opt-in
 * via `X-Polo-Client-Enterprise-Contract`. */
export const CLIENT_ENTERPRISE_CONTRACT_VERSION_R2 = "poo196-client-enterprise-r2";

/** Bound to the admin `idempotencyKeySchema` (parity regression in
 * tests/client-enterprise.contract.test.ts). */
export const clientEnterpriseIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7E]+$/, "Idempotency key must contain printable ASCII characters");

const uuidSchema = z.string().uuid();

/** The authoritative payment responsibility terms version. The client may
 * repeat this literal to show the acknowledgement it collected; it cannot
 * mint a future agreement by matching a version-shaped string. */
export const clientEnterprisePaymentResponsibilityTermsVersion = "POL-79-payment-responsibility-v1";

// ---------------------------------------------------------------------------
// Create enterprise (POST /api/client/enterprises)
// ---------------------------------------------------------------------------

/** Composed from the authoritative `createEnterpriseSchema` shape (same
 * bounds, same literals). The idempotency key arrives in the REQUIRED
 * `Idempotency-Key` header, never in the body. */
export const clientCreateEnterpriseCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    ownerName: z.string().trim().min(1).max(64),
    // D7 (r3): the introduction is OPTIONAL — omitting it, sending "" or
    // whitespace all normalise to "" (stored on the NOT NULL varchar column;
    // no placeholder text is ever synthesised). null and non-strings stay
    // rejected.
    purpose: z.string().trim().max(512).optional().default(""),
    paymentResponsibilityAccepted: z.literal(true),
    paymentResponsibilityTermsVersion: z.literal(
      clientEnterprisePaymentResponsibilityTermsVersion,
    ),
  })
  .strict();

/** The r2 wire shape: purpose is REQUIRED. A legacy-headered request is
 * validated against this so an old client can never rely on the relaxation. */
export const clientCreateEnterpriseCommandLegacySchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    ownerName: z.string().trim().min(1).max(64),
    purpose: z.string().trim().min(1).max(512),
    paymentResponsibilityAccepted: z.literal(true),
    paymentResponsibilityTermsVersion: z.literal(
      clientEnterprisePaymentResponsibilityTermsVersion,
    ),
  })
  .strict();

export type ClientCreateEnterpriseCommand = z.infer<typeof clientCreateEnterpriseCommandSchema>;

export const clientCreateEnterpriseResponseSchema = z
  .object({
    result: z.enum(["created", "replayed"]),
    enterpriseId: uuidSchema,
    productSpaceId: uuidSchema,
    viewerRole: z.literal("owner"),
    enterpriseName: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type ClientCreateEnterpriseResponse = z.infer<typeof clientCreateEnterpriseResponseSchema>;

/** GET /api/client/enterprises?createRequestKey=… — the owner's own original
 * request lookup. `unknown` is not a failure and never re-creates. */
export const clientCreateReceiptSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("created"),
      enterpriseId: uuidSchema,
      productSpaceId: uuidSchema,
      createdAt: z.string(),
    })
    .strict(),
  z.object({ state: z.literal("unknown") }).strict(),
]);

export type ClientCreateReceipt = z.infer<typeof clientCreateReceiptSchema>;

// ---------------------------------------------------------------------------
// Member roster (GET /api/client/product-spaces/[productSpaceId]/members)
// ---------------------------------------------------------------------------

export const clientMemberRoleSchema = z.enum(["owner", "manager", "member"]);
export type ClientMemberRole = z.infer<typeof clientMemberRoleSchema>;

export const clientMemberContactSchema = z
  .object({
    maskedPhone: z.string().nullable(),
    maskedEmail: z.string().nullable(),
  })
  .strict();

export const clientMemberEntrySchema = z
  .object({
    membershipId: uuidSchema,
    userId: uuidSchema,
    displayName: z.string(),
    role: clientMemberRoleSchema,
    joinedAt: z.string(),
    contact: clientMemberContactSchema,
  })
  .strict();

export const clientMemberRosterResponseSchema = z
  .object({
    productSpaceId: uuidSchema,
    enterpriseName: z.string(),
    viewerRole: clientMemberRoleSchema,
    members: z.array(clientMemberEntrySchema),
    nextCursor: z.string().nullable(),
    /** X2-9: whether THIS deployment can deliver invitation emails. The client
     * renders phone-only compose while it is false. Optional so an older admin
     * deployment simply means "unknown" — the client keeps the combined input
     * and the server's `email_delivery_unavailable` stays the authority. */
    emailDeliveryAvailable: z.boolean().optional(),
  })
  .strict();

export type ClientMemberEntry = z.infer<typeof clientMemberEntrySchema>;
export type ClientMemberRosterResponse = z.infer<typeof clientMemberRosterResponseSchema>;

// ---------------------------------------------------------------------------
// Targeted invitations (GET/POST /api/client/product-spaces/[id]/invitations)
// ---------------------------------------------------------------------------

export const clientInvitationStatusSchema = z.enum([
  "active",
  "accepted",
  "cancelled",
  "expired",
  "exhausted",
]);
export type ClientInvitationStatus = z.infer<typeof clientInvitationStatusSchema>;

/** E2-2: the copyable link is ALWAYS an absolute https URL under the
 * deployment's canonical public origin. A path-only value used to be handed to
 * the client as a broken link; the route now refuses to create the invitation
 * at all when the origin is missing or malformed, so the contract only ever
 * admits the trusted form (no userinfo, no query, no fragment). */
export const clientInvitationUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    // Userinfo (https://user:pass@host) must never leak into a shared link.
    if (parsed.username || parsed.password) return false;
    if (parsed.search || parsed.hash) return false;
    return parsed.pathname.startsWith("/invite/");
  }, "The invitation link must be an absolute https URL under the deployment's /invite/ path");

/** A projected invitation NEVER carries a token, a token hash, a creator
 * identity or a shared-application payload — the management cookie surface
 * keeps that data. */
export const clientInvitationEntrySchema = z
  .object({
    invitationId: uuidSchema,
    status: clientInvitationStatusSchema,
    maskedPhone: z.string().nullable(),
    maskedEmail: z.string().nullable(),
    expiresAt: z.string(),
    createdAt: z.string(),
    acceptedAt: z.string().nullable(),
  })
  .strict();

export const clientInvitationListResponseSchema = z
  .object({
    productSpaceId: uuidSchema,
    viewerRole: clientMemberRoleSchema,
    invitations: z.array(clientInvitationEntrySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ClientInvitationEntry = z.infer<typeof clientInvitationEntrySchema>;
export type ClientInvitationListResponse = z.infer<typeof clientInvitationListResponseSchema>;

/** One target per client request; the management cookie surface keeps the
 * bounded batch. A key is mandatory — the desktop network retry contract. */
export const clientCreateInvitationCommandSchema = z
  .object({
    targetPhone: z.string().trim().min(1).max(32).optional(),
    targetEmail: z.string().trim().email().max(320).optional(),
    createRequestKey: clientEnterpriseIdempotencyKeySchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (Boolean(input.targetPhone) === Boolean(input.targetEmail)) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one target phone or email",
      });
    }
  });

export type ClientCreateInvitationCommand = z.infer<typeof clientCreateInvitationCommandSchema>;

/** Only `created` and `replayed` carry the copyable link, and only for the
 * caller's own still-valid invitation of the SAME request key. */
export const clientCreateInvitationResponseSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("created"),
      invitation: clientInvitationEntrySchema,
      invitationUrl: clientInvitationUrlSchema,
    })
    .strict(),
  z
    .object({
      result: z.literal("replayed"),
      invitation: clientInvitationEntrySchema,
      invitationUrl: clientInvitationUrlSchema,
    })
    .strict(),
  z
    .object({
      result: z.literal("existing"),
      invitation: clientInvitationEntrySchema,
    })
    .strict(),
  z
    .object({
      result: z.literal("state_changed"),
      invitation: clientInvitationEntrySchema,
    })
    .strict(),
  z
    .object({
      result: z.literal("credential_unrecoverable"),
      invitation: clientInvitationEntrySchema,
    })
    .strict(),
]);

export type ClientCreateInvitationResponse = z.infer<typeof clientCreateInvitationResponseSchema>;

// ---------------------------------------------------------------------------
// POO-196 R3 (D6): negotiated list envelope — metadata schema + version
// literal authority. The envelope composes with each end's existing strict v1
// `ListProductSpacesResponse`; the default v1 response itself never gains a
// field.
// ---------------------------------------------------------------------------

/** The query parameter that opts a client list request into the R3 envelope. */
export const CLIENT_ENTERPRISE_LIST_CONTRACT_QUERY_PARAMETER = "clientEnterpriseContract";

export const clientEnterpriseKindSchema = z.enum(["organization", "project"]);
export type ClientEnterpriseKind = z.infer<typeof clientEnterpriseKindSchema>;

/** One metadata row per enterprise entry in the negotiated `spaces` payload.
 * The ids are the join keys: exactly one row per enterprise space, no
 * duplicates, no metadata for spaces outside the list. Unknown statistics are
 * omitted (`activeMemberCount` stays absent this round) — never fabricated. */
export const clientEnterpriseSpaceSummarySchema = z
  .object({
    productSpaceId: uuidSchema,
    enterpriseId: uuidSchema,
    enterpriseKind: clientEnterpriseKindSchema,
    purpose: z.string().max(512).optional(),
    activeMemberCount: z.number().int().min(0).optional(),
  })
  .strict();
export type ClientEnterpriseSpaceSummary = z.infer<typeof clientEnterpriseSpaceSummarySchema>;

/** `spaces` is intentionally `unknown` HERE: this module is self-contained
 * (zod-only) and must not re-declare the published v1 list schema. Both ends
 * compose this envelope with their own authoritative
 * `ListProductSpacesResponseSchema` before validating a full payload. */
export const clientEnterpriseListR3ResponseSchema = z
  .object({
    contractVersion: z.literal(CLIENT_ENTERPRISE_CONTRACT_VERSION),
    spaces: z.unknown(),
    enterpriseSummaries: z.array(clientEnterpriseSpaceSummarySchema),
  })
  .strict();
export type ClientEnterpriseListR3Response = z.infer<typeof clientEnterpriseListR3ResponseSchema>;

// ---------------------------------------------------------------------------
// POO-196 R3 (D3): restricted colleague directory projection
// ---------------------------------------------------------------------------

export const clientColleagueProjectStateSchema = z.enum([
  "joined",
  "pending",
  "available",
  "unavailable",
]);
export type ClientColleagueProjectState = z.infer<typeof clientColleagueProjectStateSchema>;

/** The directory NEVER carries a contact field, a username or an avatar URL:
 * the client renders a localized placeholder for a missing name and a
 * first-letter avatar for the always-null image. */
export const clientColleagueOptionSchema = z
  .object({
    userId: uuidSchema,
    displayName: z.string().nullable(),
    avatarUrl: z.null(),
    projectState: clientColleagueProjectStateSchema,
  })
  .strict();
export type ClientColleagueOption = z.infer<typeof clientColleagueOptionSchema>;

export const clientColleagueSourceSchema = z
  .object({
    enterpriseId: uuidSchema,
    name: z.string(),
  })
  .strict();
export type ClientColleagueSource = z.infer<typeof clientColleagueSourceSchema>;

/** `none` and `ambiguous` are SUCCESS bodies (an empty source state), never
 * errors — the client falls back to the direct phone/email invitation path. */
export const clientColleagueOptionsResponseSchema = z
  .object({
    sourceState: z.enum(["none", "ambiguous", "available"]),
    source: clientColleagueSourceSchema.nullable(),
    members: z.array(clientColleagueOptionSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ClientColleagueOptionsResponse = z.infer<typeof clientColleagueOptionsResponseSchema>;

// ---------------------------------------------------------------------------
// POO-196 R3 (D4): minimal collaboration roster — every active role reads the
// same scoped projection. No contact, no governance fields, no invitation
// records; the count comes from the same snapshot as the page.
// ---------------------------------------------------------------------------

export const clientCollaborationRosterMemberSchema = z
  .object({
    userId: uuidSchema,
    displayName: z.string().nullable(),
    avatarUrl: z.null(),
    role: clientMemberRoleSchema,
    isSelf: z.boolean(),
  })
  .strict();
export type ClientCollaborationRosterMember = z.infer<typeof clientCollaborationRosterMemberSchema>;

export const clientCollaborationRosterResponseSchema = z
  .object({
    productSpaceId: uuidSchema,
    enterpriseName: z.string(),
    viewerRole: clientMemberRoleSchema,
    totalActiveMembers: z.number().int().min(0),
    members: z.array(clientCollaborationRosterMemberSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ClientCollaborationRosterResponse = z.infer<typeof clientCollaborationRosterResponseSchema>;

// ---------------------------------------------------------------------------
// POO-196 R3 (D5): colleague invitation bridge — one selected person per
// request, resolved server-side onto the existing targeted invitation.
// ---------------------------------------------------------------------------

export const clientCreateColleagueInvitationCommandSchema = z
  .object({
    sourceEnterpriseId: uuidSchema,
    targetUserId: uuidSchema,
    createRequestKey: clientEnterpriseIdempotencyKeySchema,
  })
  .strict();
export type ClientCreateColleagueInvitationCommand = z.infer<
  typeof clientCreateColleagueInvitationCommandSchema
>;

/** The create response reuses the targeted-invitation outcome union exactly —
 * the bridge resolves to the SAME invitation kind, so `created`/`replayed`
 * carry the copyable link and every other outcome carries only the masked
 * invitation state. */
export type ClientCreateColleagueInvitationResponse = ClientCreateInvitationResponse;

/** GET ?createRequestKey=… recovery: `unknown` (202) is not a failure; a found
 * invitation projects its current masked state and — only while the caller's
 * own key is still spendable and the credential re-derives — the link. */
export const clientColleagueInvitationReceiptSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown") }).strict(),
  z
    .object({
      state: z.literal("found"),
      invitation: clientInvitationEntrySchema,
      invitationUrl: clientInvitationUrlSchema.optional(),
    })
    .strict(),
]);
export type ClientColleagueInvitationReceipt = z.infer<typeof clientColleagueInvitationReceiptSchema>;

// ---------------------------------------------------------------------------
// Pagination + stable errors
// ---------------------------------------------------------------------------

export const CLIENT_ENTERPRISE_PAGE_MAX_LIMIT = 50;
export const CLIENT_ENTERPRISE_PAGE_DEFAULT_LIMIT = 20;

export const clientPageCursorSchema = z.string().trim().min(1).max(256);

/** Stable error codes for every client enterprise route. Additive only: a
 * removed code is a breaking contract change. */
export const CLIENT_ENTERPRISE_ERROR_CODES = [
  "unauthorized",
  "token_revoked",
  "account_disabled",
  "forbidden",
  "not_found",
  "validation_error",
  "unsupported_media_type",
  "phone_verification_required",
  "account_enterprise_exists",
  "account_changed",
  "idempotency_conflict",
  "idempotency_recovery_failed",
  "legacy_projection_inconsistent",
  "target_already_member",
  "email_delivery_unavailable",
  "enterprise_unique_constraint_conflict",
  /** E2-2: the deployment's public origin is missing or malformed, so no
   * trusted link can be built and the invitation is NOT created (zero write).
   * Additive: never reuse a removed code. */
  "invitation_origin_unavailable",
  /** POO-196 R3 (D5): the caller has no (or an ambiguous) valid organization
   * membership to source colleagues from, or the referenced source enterprise
   * is not that membership. Additive. */
  "colleague_source_unavailable",
  /** POO-196 R3 (D5): the selected colleague has no verified contact the
   * server may resolve a targeted invitation onto (or their account cannot
   * receive one). Additive. */
  "colleague_target_unavailable",
  /** POO-196 R3 (D6/D7): the negotiated contract version is not implemented
   * by this deployment. Additive. */
  "contract_version_unsupported",
] as const;

export type ClientEnterpriseErrorCode = (typeof CLIENT_ENTERPRISE_ERROR_CODES)[number];

export const ClientEnterpriseErrorEnvelopeSchema = z
  .object({
    error: z.enum(CLIENT_ENTERPRISE_ERROR_CODES),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// Keep the marked slice self-contained: no imports, no admin-only types.
export const clientEnterpriseCreatePresentation = {
  /** Authoritative terms version the client must echo back unchanged. */
  termsVersion: "POL-79-payment-responsibility-v1",
  /** The field bounds the client form must enforce; bound to the SOT schema. */
  fieldLimits: { nameMax: 128, ownerNameMax: 64, purposeMax: 512 },
  fields: {
    projectName: { label: "项目名称", hint: "将创建企业空间，项目成员都可访问此项目。" },
    ownerName: { label: "你的姓名", hint: "成员会看到这个名字（显示在邀请与审批里）。" },
    purpose: { label: "主要用途" },
  },
  responsibility: {
    scopeStatement: "将创建企业空间，你将成为唯一负责人；该企业的成员都可访问此项目",
    confirmStatement: "我确认成为唯一负责人并承担企业付款责任",
    confirmDefaultChecked: false,
    versionMismatchHint: "付款责任条款已更新，请刷新后重新确认再提交。",
  },
  budgetFact: "预算默认关闭，可由负责人开启。创建不要求预充值、导入工具或邀请成员。",
} as const;