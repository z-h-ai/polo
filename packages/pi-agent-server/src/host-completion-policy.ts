/**
 * Host single-attempt transport observation seam (POO-69).
 *
 * A one-shot Host worker installs this BEFORE pi-ai is loaded (POO-68 owns the bootstrap). One
 * request-local `TransportObservation` covers both transports: the saved-original
 * `globalThis.fetch` gets a fail-closed URL policy wrapper (always `redirect: 'error'`), and the
 * shared `BedrockRuntimeClient` send wrapper guards each instance's resolved
 * `config.requestHandler.handle` — the AWS retry middleware's per-wire-attempt entry point. The
 * second wire attempt throws an internal `RetryBlockedError` before the original transport, an
 * unguardable request handler is latched fail-closed, object fetch inputs are bound to their
 * intrinsic transport snapshot, and observations hold only counts/status, never provider content.
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

function seamError(reason: string): Error {
  return new Error(`host transport seam: ${reason}`);
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
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
    if (segment === '') {
      continue;
    }
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
  const handlerStates = new WeakMap<object, 'guarded' | 'failed'>();
  clientPrototype.send = function (this: BedrockRuntimeClient, ...args: unknown[]): unknown {
    const requestHandler = (this.config as { requestHandler?: { handle?: (request: unknown, options?: unknown) => Promise<unknown> } } | undefined)?.requestHandler;
    if (!requestHandler || typeof requestHandler.handle !== 'function') {
      throw seamError('resolved Bedrock request handler has no callable handle');
    }
    if (handlerStates.get(requestHandler) === 'failed') {
      throw seamError('Bedrock request handler handle is not writable');
    }
    if (handlerStates.get(requestHandler) !== 'guarded') {
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
      // Atomic install: assign, verify the write landed, then mark; any failure latches fail-closed.
      try {
        requestHandler.handle = wrapped;
        if (requestHandler.handle !== wrapped) {
          throw seamError('Bedrock request handler handle is not writable');
        }
      } catch {
        handlerStates.set(requestHandler, 'failed');
        throw seamError('Bedrock request handler handle is not writable');
      }
      handlerStates.set(requestHandler, 'guarded');
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
  const observation: TransportObservation = {
    attempts: 0,
    networkFailure: false,
    retryBlocked: false,
    sdkException: false,
  };
  const originalFetch = globalThis.fetch;
  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // One native Request(input, init) snapshot: validated, gated, transmitted; redirect forced by init.
    let snapshot: Request;
    if (input instanceof Request) {
      const intrinsicUrl = Reflect.get(Request.prototype, 'url', input) as string;
      if (input.url !== intrinsicUrl) {
        throw seamError('request input url is not internally consistent');
      }
      snapshot = new Request(input, init);
      if (snapshot.url !== intrinsicUrl) {
        throw seamError('request input url is not internally consistent');
      }
    } else if (typeof input === 'string' || input instanceof URL) {
      const target = new URL(typeof input === 'string' ? input : URL.prototype.toString.call(input));
      assertAllowedTarget(baseOrigin, basePathname, target, 'request url');
      snapshot = new Request(target, init);
    } else {
      throw seamError('fetch input must be a string, URL or Request');
    }
    assertAllowedTarget(baseOrigin, basePathname, new URL(snapshot.url), 'request url');
    gateSecondWireAttempt(observation);
    try {
      const response = await originalFetch.call(globalThis, snapshot, { redirect: 'error' });
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
