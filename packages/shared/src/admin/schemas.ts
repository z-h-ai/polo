import { z } from 'zod'

const nonBlankString = (maxLength: number) =>
  z.string()
    .min(1)
    .max(maxLength)
    .refine(value => value.trim().length > 0)

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

export const AdminLoginRpcInputSchema = z.object({
  identifier: nonBlankString(512),
  password: z.string().min(1).max(1_024),
})

export const SendPhoneAuthCodeRpcInputSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  challengeToken: nonBlankString(8_192),
})

export const VerifyPhoneAuthCodeRpcInputSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  code: z.string().regex(/^\d{6}$/),
})

export const SetAdminPasswordRpcInputSchema = z.object({
  password: z.string().min(8).max(1_024),
})
