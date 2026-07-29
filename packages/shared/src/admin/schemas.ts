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
