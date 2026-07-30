import { z } from 'zod'

const nonBlankString = (maxLength: number) =>
  z.string()
    .min(1)
    .max(maxLength)
    .refine(value => value.trim().length > 0)

const adminToken = nonBlankString(16_384)
const sessionLifetimeSeconds = z.number().finite().int().min(1).max(31_536_000)
const phoneAuthLifetimeSeconds = z.number().finite().int().min(1).max(86_400)
const phoneAuthDelaySeconds = z.number().finite().int().min(0).max(86_400)
const httpUrl = z.string().url().max(16_384).refine(value => {
  const protocol = new URL(value).protocol
  return protocol === 'https:' || protocol === 'http:'
})

export const MainlandChinaPhoneSchema = z.string().regex(/^1[3-9]\d{9}$/)

export function isValidMainlandChinaPhone(value: string): boolean {
  return MainlandChinaPhoneSchema.safeParse(value).success
}

/**
 * Runtime boundary for user data received from Admin.
 * Zod objects strip unknown fields by default, so only this explicit allowlist
 * can leave AdminClient and reach local RPC consumers.
 */
export const AdminUserSchema = z.object({
  id: nonBlankString(512),
  username: nonBlankString(512),
  displayName: z.string().max(2_048).nullable(),
  role: nonBlankString(128),
  groupIds: z.array(nonBlankString(512)).max(10_000),
})

const AdminSessionSchema = z.object({
  accessToken: adminToken,
  refreshToken: adminToken,
  expiresIn: sessionLifetimeSeconds,
})

export const AdminLoginResponseSchema = AdminSessionSchema.extend({
  user: AdminUserSchema,
})

export const AdminPhoneAuthResponseSchema = AdminLoginResponseSchema.extend({
  isNewUser: z.boolean(),
})

export const AdminRefreshResponseSchema = AdminSessionSchema

export const AdminValidateResponseSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(true),
    user: AdminUserSchema,
    configVersion: nonBlankString(512),
  }),
  z.object({
    valid: z.literal(false),
  }),
])

export const SendPhoneAuthCodeResponseSchema = z.object({
  accepted: z.literal(true),
  expiresIn: phoneAuthLifetimeSeconds,
  resendAfter: phoneAuthDelaySeconds,
})

export const SetAdminPasswordResponseSchema = z.object({
  success: z.literal(true),
})

export const AdminEntityIdSchema = nonBlankString(512)
const entityId = AdminEntityIdSchema
const organizationDate = z.string().datetime({ offset: true })

export const OrganizationTypeSchema = z.enum(['enterprise_workspace', 'creator_space'])
export const OrganizationRoleSchema = z.enum(['owner', 'manager', 'member'])
export const OrganizationMembershipStatusSchema = z.enum(['active', 'suspended', 'removed'])
export const OrganizationJoinStatusSchema = z.enum([
  'active',
  'cancelled',
  'revoked',
  'expired',
  'exhausted',
  'unavailable',
])

export const OrganizationSchema = z.object({
  id: entityId,
  type: OrganizationTypeSchema,
  name: nonBlankString(128),
  purpose: nonBlankString(512),
  visibility: z.literal('private').optional(),
  status: z.enum(['active', 'suspended']).optional(),
  createdAt: organizationDate.optional(),
  updatedAt: organizationDate.optional(),
})

export const OrganizationMembershipSchema = z.object({
  id: entityId,
  organizationId: entityId.optional(),
  userId: entityId.optional(),
  role: OrganizationRoleSchema,
  status: OrganizationMembershipStatusSchema,
  joinedAt: organizationDate.optional(),
  updatedAt: organizationDate.optional(),
})

export const ListOrganizationsResponseSchema = z.object({
  organizations: z.array(OrganizationSchema.extend({
    membership: OrganizationMembershipSchema,
    memberCount: z.number().int().min(0),
  })),
})

export const AppReleaseSummarySchema = z.object({
  version: nonBlankString(128),
  runtime: z.enum(['static', 'python', 'js']),
  downloadUrl: httpUrl,
  checksum: z.string().regex(/^[a-fA-F0-9]{64}$/),
  sizeBytes: z.number().int().min(0),
  platform: z.enum(['darwin', 'win32', 'linux']).optional(),
  arch: z.enum(['arm64', 'x64']).optional(),
})

export const CatalogAppSchema = z.object({
  id: entityId,
  organizationId: entityId,
  name: nonBlankString(256),
  description: z.string().max(4_096),
  iconUrl: httpUrl.optional(),
  creatorName: z.string().max(512).optional(),
  deliveryMode: z.enum(['remote_url', 'local_bundle']),
  remoteUrl: httpUrl.optional(),
  currentRelease: AppReleaseSummarySchema.optional(),
  permissions: z.array(nonBlankString(512)).max(1_000).optional(),
  sortOrder: z.number().int(),
}).superRefine((app, context) => {
  if (app.deliveryMode === 'remote_url' && !app.remoteUrl) {
    context.addIssue({
      code: 'custom',
      message: 'remoteUrl is required for remote_url apps',
      path: ['remoteUrl'],
    })
  }
  if (app.deliveryMode === 'local_bundle' && !app.currentRelease) {
    context.addIssue({
      code: 'custom',
      message: 'currentRelease is required for local_bundle apps',
      path: ['currentRelease'],
    })
  }
})

export const AppCatalogResponseSchema = z.object({
  appConfigVersion: nonBlankString(512),
  apps: z.array(CatalogAppSchema).max(10_000),
}).superRefine((catalog, context) => {
  const appIds = new Set<string>()
  catalog.apps.forEach((app, index) => {
    if (appIds.has(app.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Catalog app ids must be unique',
        path: ['apps', index, 'id'],
      })
      return
    }
    appIds.add(app.id)
  })
})

/**
 * Fail-closed Catalog projection exposed outside the trusted main process.
 *
 * The allowlist intentionally excludes every delivery capability, including
 * remoteUrl, currentRelease, permissions, and trusted release metadata.
 */
export const DeniedCatalogAppSchema = z.object({
  id: entityId,
  organizationId: entityId,
  name: nonBlankString(256),
  description: z.string().max(4_096),
  iconUrl: httpUrl.optional(),
  creatorName: z.string().max(512).optional(),
  deliveryMode: z.enum(['remote_url', 'local_bundle']),
  sortOrder: z.number().int(),
  availability: z.literal('unavailable'),
}).strict()

export const DeniedAppCatalogSnapshotSchema = z.object({
  accountId: entityId,
  organizationId: entityId,
  appConfigVersion: nonBlankString(512),
  authorizationStatus: z.literal('denied'),
  syncedAt: z.number().int().min(0),
  apps: z.array(DeniedCatalogAppSchema).max(10_000),
  withdrawnApps: z.array(DeniedCatalogAppSchema).max(10_000).optional(),
}).strict()

export const CreateOrganizationResponseSchema = z.object({
  organization: OrganizationSchema,
  membership: OrganizationMembershipSchema,
  replayed: z.boolean(),
})

export const OrganizationJoinPreviewSchema = z.object({
  organization: OrganizationSchema,
  join: z.object({
    kind: z.enum(['invitation', 'join_link']),
    effectiveStatus: OrganizationJoinStatusSchema,
    expiresAt: organizationDate.nullable(),
    usesRemaining: z.number().int().min(0).nullable(),
    requiresPhoneMatch: z.boolean(),
  }),
})

export const AcceptOrganizationJoinResponseSchema = z.object({
  membership: OrganizationMembershipSchema.extend({
    organizationId: entityId,
    userId: entityId,
  }),
  replayed: z.boolean(),
})

export const ListOrganizationMembersResponseSchema = z.object({
  members: z.array(z.object({
    id: entityId,
    role: OrganizationRoleSchema,
    status: z.enum(['active', 'suspended']),
    joinedAt: organizationDate,
    updatedAt: organizationDate,
    user: z.object({
      id: entityId,
      username: nonBlankString(512),
      displayName: z.string().max(2_048).nullable(),
      phone: z.string().max(32).nullable().optional(),
    }),
  })),
})

export const OrganizationInvitationSchema = z.object({
  id: entityId,
  targetPhone: z.string().max(32).nullable(),
  status: nonBlankString(64),
  effectiveStatus: z.enum(['active', 'cancelled', 'expired', 'exhausted']),
  maxUses: z.number().int().min(1),
  useCount: z.number().int().min(0),
  expiresAt: organizationDate,
  cancelledAt: organizationDate.nullable().optional(),
  createdAt: organizationDate,
  createdByUserId: entityId.optional(),
})

export const ListOrganizationInvitationsResponseSchema = z.object({
  invitations: z.array(OrganizationInvitationSchema),
})

export const CreateOrganizationInvitationResponseSchema = z.object({
  invitation: OrganizationInvitationSchema,
  token: nonBlankString(256),
})

export const OrganizationJoinLinkSchema = z.object({
  id: entityId,
  status: nonBlankString(64),
  effectiveStatus: OrganizationJoinStatusSchema.optional(),
  maxUses: z.number().int().min(1).nullable(),
  useCount: z.number().int().min(0),
  expiresAt: organizationDate.nullable(),
  createdAt: organizationDate.optional(),
  revokedAt: organizationDate.nullable().optional(),
})

export const CreateOrganizationJoinLinkResponseSchema = z.object({
  joinLink: OrganizationJoinLinkSchema,
  token: nonBlankString(256),
})

export const OrganizationMemberMutationResponseSchema = z.object({
  membership: OrganizationMembershipSchema,
})

export const OrganizationInvitationMutationResponseSchema = z.object({
  invitation: z.object({
    id: entityId,
    status: nonBlankString(64),
    cancelledAt: organizationDate.nullable(),
  }),
})

export const OrganizationJoinLinkMutationResponseSchema = z.object({
  joinLink: z.object({
    id: entityId,
    status: nonBlankString(64),
    revokedAt: organizationDate.nullable(),
  }),
})

export const AdminLoginRpcInputSchema = z.object({
  identifier: nonBlankString(512),
  password: z.string().min(1).max(1_024),
})

export const SendPhoneAuthCodeRpcInputSchema = z.object({
  phone: MainlandChinaPhoneSchema,
  challengeToken: nonBlankString(8_192),
})

export const VerifyPhoneAuthCodeRpcInputSchema = z.object({
  phone: MainlandChinaPhoneSchema,
  code: z.string().regex(/^\d{6}$/),
})

export const SetAdminPasswordRpcInputSchema = z.object({
  password: z.string().min(8).max(1_024),
})

export const OrganizationIdRpcInputSchema = z.string().uuid()
export const CatalogOrganizationIdRpcInputSchema = AdminEntityIdSchema
export const OrganizationJoinTokenRpcInputSchema = z.string().min(20).max(256)
export const CreateOrganizationRpcInputSchema = z.object({
  type: OrganizationTypeSchema,
  name: z.string().trim().min(1).max(128),
  purpose: z.string().trim().min(1).max(512),
  idempotencyKey: z.string().min(1).max(128).regex(/^[\x21-\x7E]+$/),
}).strict()
export const CreateOrganizationInvitationRpcInputSchema = z.object({
  targetPhone: z.string().trim().min(1).max(32).optional(),
  expiresAt: organizationDate.optional(),
  maxUses: z.number().int().min(1).max(1_000).optional(),
}).strict()
export const CreateOrganizationJoinLinkRpcInputSchema = z.object({
  expiresAt: organizationDate.nullable().optional(),
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
}).strict()
export const UpdateOrganizationMemberRpcInputSchema = z.object({
  role: z.enum(['manager', 'member']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  reason: z.string().trim().min(1).max(512).optional(),
}).strict().refine(value => value.role !== undefined || value.status !== undefined)
export const RemoveOrganizationMemberRpcInputSchema = z.object({
  reason: z.string().trim().min(1).max(512).optional(),
}).strict()
