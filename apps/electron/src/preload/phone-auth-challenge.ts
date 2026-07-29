import { randomBytes } from 'node:crypto'
import {
  createCallbackServer,
  type CallbackServer,
} from '@polo-ai/shared/auth/callback-server'
import type { RpcClient } from '@polo-ai/server-core/transport'
import { RPC_CHANNELS } from '../shared/types'

const DEFAULT_CHALLENGE_PATH = '/auth/phone-challenge'
const CHALLENGE_TIMEOUT_MS = 120_000
const MAX_CHALLENGE_TOKEN_LENGTH = 4096

export type PhoneAuthChallengeResult =
  | { success: true; challengeToken: string }
  | { success: false; errorCode: 'phone_auth_configuration_error' }

export interface PhoneAuthChallengeDependencies {
  configuredIssuerUrl?: string
  createCallback?: () => Promise<CallbackServer>
  openExternal: (url: string) => Promise<unknown>
  timeoutMs?: number
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function resolvePhoneAuthChallengeIssuerUrl(
  adminUrl: string,
  configuredIssuerUrl?: string,
): URL {
  const issuerUrl = configuredIssuerUrl?.trim()
    ? new URL(configuredIssuerUrl)
    : new URL(DEFAULT_CHALLENGE_PATH, adminUrl)

  if (
    issuerUrl.username
    || issuerUrl.password
    || (issuerUrl.protocol !== 'https:'
      && !(issuerUrl.protocol === 'http:' && isLoopbackHost(issuerUrl.hostname)))
  ) {
    throw new Error('Phone auth challenge issuer must use HTTPS')
  }

  return issuerUrl
}

function createTimeout<T>(timeoutMs: number): {
  promise: Promise<T>
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Phone auth challenge timed out')), timeoutMs)
  })
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer)
    },
  }
}

/**
 * Opens the configured challenge issuer in the system browser and accepts only
 * the opaque code returned through a state-bound loopback callback. The client
 * never invents or transforms the anti-abuse token.
 */
export async function acquirePhoneAuthChallenge(
  client: Pick<RpcClient, 'invoke'>,
  dependencies: PhoneAuthChallengeDependencies,
): Promise<PhoneAuthChallengeResult> {
  let callbackServer: CallbackServer | null = null
  const timeout = createTimeout<never>(
    Math.max(1, dependencies.timeoutMs ?? CHALLENGE_TIMEOUT_MS),
  )

  try {
    const status = await client.invoke(RPC_CHANNELS.admin.GET_STATUS) as {
      adminUrl?: string
    }
    if (!status.adminUrl) {
      return { success: false, errorCode: 'phone_auth_configuration_error' }
    }

    const issuerUrl = resolvePhoneAuthChallengeIssuerUrl(
      status.adminUrl,
      dependencies.configuredIssuerUrl,
    )
    callbackServer = await (dependencies.createCallback
      ? dependencies.createCallback()
      : createCallbackServer({
          appType: 'electron',
          callbackPaths: ['/phone-auth/callback'],
        }))

    const state = randomBytes(24).toString('base64url')
    issuerUrl.searchParams.set(
      'redirect_uri',
      `${callbackServer.url}/phone-auth/callback`,
    )
    issuerUrl.searchParams.set('state', state)
    issuerUrl.searchParams.set('client_id', 'polo-electron')

    await dependencies.openExternal(issuerUrl.toString())
    const callback = await Promise.race([
      callbackServer.promise,
      timeout.promise,
    ])

    if (callback.query.error || callback.query.state !== state) {
      return { success: false, errorCode: 'phone_auth_configuration_error' }
    }

    const challengeToken = callback.query.code?.trim()
    if (
      !challengeToken
      || challengeToken.length > MAX_CHALLENGE_TOKEN_LENGTH
    ) {
      return { success: false, errorCode: 'phone_auth_configuration_error' }
    }

    return { success: true, challengeToken }
  } catch {
    return { success: false, errorCode: 'phone_auth_configuration_error' }
  } finally {
    timeout.cancel()
    await callbackServer?.close()
  }
}
