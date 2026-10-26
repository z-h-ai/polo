import { randomBytes } from 'node:crypto'
import {
  createCallbackServer,
  type CallbackPayload,
  type CallbackServer,
} from '@polo-ai/shared/auth/callback-server'
import type { RpcClient } from '@polo-ai/server-core/transport'
import { RPC_CHANNELS } from '../shared/types'

const CHALLENGE_TIMEOUT_MS = 120_000
const MAX_CHALLENGE_TOKEN_LENGTH = 4096
export const MAX_PHONE_AUTH_ISSUER_URL_LENGTH = 2048

/**
 * POO-151 error grading: a challenge that did not complete is NOT a
 * configuration problem. Discovery/issuer/callback-server failures stay
 * `phone_auth_configuration_error`; the challenge itself timing out or
 * failing validation is `phone_auth_challenge_failed`; the user closing the
 * in-app challenge window is `phone_auth_challenge_cancelled`. The renderer
 * maps the latter two to the same "challenge failed, please retry" copy.
 */
export type PhoneAuthChallengeErrorCode =
  | 'phone_auth_configuration_error'
  | 'phone_auth_challenge_failed'
  | 'phone_auth_challenge_cancelled'

export type PhoneAuthChallengeResult =
  | { success: true; challengeToken: string }
  | { success: false; errorCode: PhoneAuthChallengeErrorCode }

/**
 * POO-151: app-owned challenge window (main-process BrowserWindow behind IPC).
 * Present in production builds; E2E builds omit it and keep `openExternal`.
 */
export interface PhoneAuthChallengeWindowController {
  open: (url: string) => Promise<unknown>
  close: () => Promise<unknown>
  /** Notifies when the window was closed by any route outside this flow. */
  onClosed: (listener: () => void) => () => void
}

export interface PhoneAuthChallengeDependencies {
  /**
   * Trusted host-only capability for local development/E2E providers.
   * Renderer input and discovery payloads must never control this value.
   */
  allowInsecureLoopbackIssuer?: boolean
  createCallback?: () => Promise<CallbackServer>
  openExternal: (url: string) => Promise<unknown>
  /** When provided, the issuer page is hosted in-app instead of externally. */
  challengeWindow?: PhoneAuthChallengeWindowController
  timeoutMs?: number
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function resolvePhoneAuthChallengeIssuerUrl(
  discoveredIssuerUrl: string,
  allowInsecureLoopbackIssuer = false,
): URL {
  if (
    !discoveredIssuerUrl
    || discoveredIssuerUrl.length > MAX_PHONE_AUTH_ISSUER_URL_LENGTH
  ) {
    throw new Error('Phone auth challenge issuer URL is invalid')
  }

  const issuerUrl = new URL(discoveredIssuerUrl)
  const isTrustedLoopbackHttp = (
    allowInsecureLoopbackIssuer
    && issuerUrl.protocol === 'http:'
    && isLoopbackHost(issuerUrl.hostname)
  )

  if (
    issuerUrl.username
    || issuerUrl.password
    || (issuerUrl.protocol !== 'https:' && !isTrustedLoopbackHttp)
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
 * Hosts the configured challenge issuer in-app (production) or in the system
 * browser (legacy/E2E) and accepts only the opaque code returned through a
 * state-bound loopback callback. The client never invents or transforms the
 * anti-abuse token.
 */
export async function acquirePhoneAuthChallenge(
  client: Pick<RpcClient, 'invoke'>,
  dependencies: PhoneAuthChallengeDependencies,
): Promise<PhoneAuthChallengeResult> {
  let callbackServer: CallbackServer | null = null
  const timeout = createTimeout<never>(
    Math.max(1, dependencies.timeoutMs ?? CHALLENGE_TIMEOUT_MS),
  )
  const challengeWindow = dependencies.challengeWindow

  try {
    const discovery = await client.invoke(
      RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG,
    ) as {
      success?: boolean
      type?: string
      issuerUrl?: string
    }
    if (
      discovery.success !== true
      || discovery.type !== 'browser_redirect'
      || typeof discovery.issuerUrl !== 'string'
      || !discovery.issuerUrl.trim()
    ) {
      return { success: false, errorCode: 'phone_auth_configuration_error' }
    }

    const issuerUrl = resolvePhoneAuthChallengeIssuerUrl(
      discovery.issuerUrl,
      dependencies.allowInsecureLoopbackIssuer === true,
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

    let unsubscribeClosed: (() => void) | null = null
    // Resolve is held on an object, NOT a bare `let`: Bun's transpiler
    // narrows a null-initialized `let` and drops the later `x?.()`/`x()` call
    // entirely, leaving the promise pending (verified on bun 1.3.14).
    const closedGate: { resolve: ((value: 'cancelled') => void) | null } = { resolve: null }
    const closedPromise = new Promise<'cancelled'>((resolve) => {
      closedGate.resolve = resolve
    })

    try {
      if (challengeWindow) {
        // In-app hosting (POO-151): the window starts hidden and only
        // surfaces when the challenge needs interaction. A close from any
        // route outside this flow means the user gave up — cancel at once
        // instead of waiting out the timeout.
        unsubscribeClosed = challengeWindow.onClosed(() => closedGate.resolve?.('cancelled'))
        await challengeWindow.open(issuerUrl.toString())
        const outcome = await Promise.race([
          callbackServer.promise.then(
            callback => ({ kind: 'callback', callback }) as const,
          ),
          timeout.promise.then(
            () => ({ kind: 'timeout' }) as const,
            () => ({ kind: 'timeout' }) as const,
          ),
          closedPromise,
        ])

        if (outcome === 'cancelled') {
          return { success: false, errorCode: 'phone_auth_challenge_cancelled' }
        }
        if (outcome.kind === 'timeout') {
          return { success: false, errorCode: 'phone_auth_challenge_failed' }
        }
        return finishChallenge(outcome.callback, state)
      }

      // Legacy path (E2E): follow the redirect externally; the mock provider
      // auto-completes, so cancellation cannot happen here.
      await dependencies.openExternal(issuerUrl.toString())
      const callback = await Promise.race([
        callbackServer.promise,
        timeout.promise.then(
          () => null,
          () => null,
        ),
      ])
      if (!callback) {
        return { success: false, errorCode: 'phone_auth_challenge_failed' }
      }
      return finishChallenge(callback, state)
    } finally {
      unsubscribeClosed?.()
      await challengeWindow?.close()
    }
  } catch {
    return { success: false, errorCode: 'phone_auth_configuration_error' }
  } finally {
    timeout.cancel()
    await callbackServer?.close()
  }
}

function finishChallenge(
  callback: CallbackPayload,
  state: string,
): PhoneAuthChallengeResult {
  if (callback.query.error || callback.query.state !== state) {
    return { success: false, errorCode: 'phone_auth_challenge_failed' }
  }

  const challengeToken = callback.query.code?.trim()
  if (
    !challengeToken
    || challengeToken.length > MAX_CHALLENGE_TOKEN_LENGTH
  ) {
    return { success: false, errorCode: 'phone_auth_challenge_failed' }
  }

  return { success: true, challengeToken }
}
