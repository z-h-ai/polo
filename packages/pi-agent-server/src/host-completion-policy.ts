/**
 * Host single-attempt transport observation seam (POO-69).
 *
 * A one-shot Host worker installs this BEFORE pi-ai is loaded (POO-68 owns the
 * bootstrap). One request-local `TransportObservation` covers both transports:
 * the saved-original `globalThis.fetch` gets a fail-closed URL policy wrapper
 * (always `redirect: 'error'`), and the shared `BedrockRuntimeClient` send
 * wrapper guards each instance's resolved `config.requestHandler.handle` —
 * the AWS retry middleware's per-wire-attempt entry point. The second wire attempt throws an
 * internal `RetryBlockedError` before the original transport, an unguardable request handler
 * is latched fail-closed, object fetch inputs are bound to their intrinsic transport snapshot,
 * and observations hold only counts and numeric status, never provider content.
 */

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

export interface TransportObservation {
  attempts: number;
  status?: number;
  networkFailure: boolean;
  retryBlocked: boolean;
  sdkException: boolean;
}

export interface InstalledTransportObservation {
  observation: TransportObservation;
  bedrockConstructor: typeof BedrockRuntimeClient;
}

const SEAM_ERROR_PREFIX = 'host transport seam:';

function seamError(reason: string): Error {
  return new Error(`${SEAM_ERROR_PREFIX} ${reason}`);
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) ? value : undefined;
}

/** Comparable origin: lowercase protocol, bracket-less lowercase hostname, effective port. */
function originKeyOf(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/^\[(.+)\]$/, '$1');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol.toLowerCase()}//${hostname}:${port}`;
}

/** Fail closed: http(s) without userinfo/fragment, immutable captured base origin/path, single-decode segments. */
function assertAllowedTarget(baseOrigin: string, basePathname: string, target: URL, label: string): void {
  const badScheme = target.protocol !== 'http:' && target.protocol !== 'https:';
  if (badScheme || target.username !== '' || target.password !== '' || target.hash !== '') {
    throw seamError(`${label} must be http(s) without userinfo or fragment`);
  }
  if (originKeyOf(target) !== baseOrigin) {
    throw seamError('request origin differs from the installed base origin');
  }
  const prefix = basePathname.endsWith('/') ? basePathname : `${basePathname}/`;
  if (target.pathname !== basePathname && !target.pathname.startsWith(prefix)) {
    throw seamError('request path is not the base path or a descendant of it');
  }
  for (const segment of target.pathname.split('/')) {
    if (segment === '') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw seamError(`${label} has a path segment that fails to decode`);
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw seamError(`${label} has a path segment escaping its base path`);
    }
  }
}

function gateSecondWireAttempt(observation: TransportObservation): void {
  observation.attempts += 1;
  if (observation.attempts > 1) {
    observation.retryBlocked = true;
    throw Object.assign(seamError('second wire attempt blocked'), { name: 'RetryBlockedError' });
  }
}

function installBedrockSendSeam(observation: TransportObservation): void {
  const clientPrototype = BedrockRuntimeClient.prototype as { send?: unknown };
  if (typeof clientPrototype.send !== 'function') {
    throw seamError('BedrockRuntimeClient.prototype.send is not callable');
  }
  const originalSend = clientPrototype.send as (this: BedrockRuntimeClient, ...args: unknown[]) => unknown;
  const guardedHandlers = new WeakSet<object>();
  const failedInstalls = new WeakSet<object>();
  const HANDLE_NOT_WRITABLE = 'Bedrock request handler handle is not writable';
  clientPrototype.send = function (this: BedrockRuntimeClient, ...args: unknown[]): unknown {
    const requestHandler = (this.config as { requestHandler?: { handle?: (request: unknown, options?: unknown) => Promise<unknown> } } | undefined)?.requestHandler;
    if (!requestHandler || typeof requestHandler.handle !== 'function') {
      throw seamError('resolved Bedrock request handler has no callable handle');
    }
    if (failedInstalls.has(requestHandler)) {
      throw seamError(HANDLE_NOT_WRITABLE);
    }
    if (!guardedHandlers.has(requestHandler)) {
      const originalHandle = requestHandler.handle;
      const wrapped = async (request: unknown, options?: unknown): Promise<unknown> => {
        gateSecondWireAttempt(observation);
        try {
          const result = await originalHandle.call(requestHandler, request, options);
          observation.status ??=
            finiteInteger((result as { response?: { statusCode?: unknown } } | undefined)?.response?.statusCode);
          return result;
        } catch (error) {
          observation.networkFailure = true;
          throw error;
        }
      };
      // Atomic install: assign, verify, then mark; a failed install is latched and fails closed.
      try {
        requestHandler.handle = wrapped;
        if (requestHandler.handle !== wrapped) {
          throw seamError(HANDLE_NOT_WRITABLE);
        }
      } catch {
        failedInstalls.add(requestHandler);
        throw seamError(HANDLE_NOT_WRITABLE);
      }
      guardedHandlers.add(requestHandler);
    }
    const pending = originalSend.apply(this, args) as Promise<unknown> | undefined;
    if (typeof pending?.then === 'function') {
      return pending.then(undefined, (error: unknown) => {
        observation.sdkException = true;
        observation.status ??=
          finiteInteger((error as { $metadata?: { httpStatusCode?: unknown } } | undefined)?.$metadata?.httpStatusCode);
        throw error;
      });
    }
    return pending;
  };
}

export function installTransportObservation(baseUrl: URL): InstalledTransportObservation {
  const baseSnapshot = new URL(URL.prototype.toString.call(baseUrl));
  const baseOrigin = originKeyOf(baseSnapshot);
  const basePathname = baseSnapshot.pathname;
  assertAllowedTarget(baseOrigin, basePathname, baseSnapshot, 'base url');
  const observation: TransportObservation = { attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false };
  const originalFetch = globalThis.fetch;
  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // One native Request(input, init) snapshot; validation and transport share this exact input.
    // A used/locked input body without an init.body replacement fails like native fetch.
    if (input instanceof Request && (init === undefined || !('body' in init)) && input.body !== null && (input.bodyUsed || input.body.locked)) {
      throw new TypeError('Request body is unusable');
    }
    let snapshot: Request;
    if (input instanceof Request) {
      snapshot = new Request(input, init);
    } else if (input instanceof URL) {
      const target = new URL(URL.prototype.toString.call(input));
      assertAllowedTarget(baseOrigin, basePathname, target, 'request url');
      snapshot = new Request(target, init);
    } else if (typeof input === 'string') {
      const target = new URL(input);
      assertAllowedTarget(baseOrigin, basePathname, target, 'request url');
      snapshot = new Request(target, init);
    } else {
      throw seamError('fetch input must be a string, URL or Request');
    }
    const guarded = new Request(snapshot, { redirect: 'error' });
    assertAllowedTarget(baseOrigin, basePathname, new URL(guarded.url), 'request url');
    gateSecondWireAttempt(observation);
    try {
      const response = await originalFetch.call(globalThis, guarded);
      observation.status = response.status;
      return response;
    } catch (error) {
      observation.networkFailure = true;
      throw error;
    }
  };
  installBedrockSendSeam(observation);
  globalThis.fetch = wrappedFetch as typeof globalThis.fetch;
  return { observation, bedrockConstructor: BedrockRuntimeClient };
}

/** Fixed-priority pure classification (deadline → retry → 401/403 → request → terminal). */
export function classifyTransportFailure(
  observation: Readonly<TransportObservation>,
  flags: { deadlineExpired: boolean; providerFailed: boolean },
): 'deadline_exceeded' | 'retry_blocked' | 'provider_rejected_credentials'
  | 'provider_request_failed' | 'provider_error_terminal' | undefined {
  if (flags.deadlineExpired) {
    return 'deadline_exceeded';
  }
  if (observation.retryBlocked || observation.attempts > 1) {
    return 'retry_blocked';
  }
  if (observation.status === 401 || observation.status === 403) {
    return 'provider_rejected_credentials';
  }
  if (observation.networkFailure || (flags.providerFailed && typeof observation.status === 'number')) {
    return 'provider_request_failed';
  }
  if (observation.sdkException || flags.providerFailed) {
    return 'provider_error_terminal';
  }
  return undefined;
}
