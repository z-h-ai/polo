/**
 * Host single-attempt transport observation seam (POO-69).
 *
 * A one-shot Host worker installs this BEFORE pi-ai is loaded (POO-68 owns the bootstrap). One
 * request-local `TransportObservation` covers both transports: the saved-original
 * `globalThis.fetch` gets a fail-closed URL policy wrapper (always `redirect: 'error'`) as a
 * transparent `Proxy` preserving the saved callable's runtime surface, and the shared
 * `BedrockRuntimeClient` send wrapper guards each resolved `config.requestHandler.handle` (the
 * AWS retry middleware's per-wire-attempt entry point). The second wire attempt throws an
 * internal `RetryBlockedError` before the original transport, an unguardable handler is latched
 * fail-closed before later handle reads, Proxy Request inputs are rejected before any URL read,
 * object fetch inputs are bound to their intrinsic snapshot, observations hold counts/status only.
 */

import { types } from 'node:util';
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

type SeamSend = (this: BedrockRuntimeClient, ...args: unknown[]) => unknown;
type SeamRequestHandler = { handle?: (request: unknown, options?: unknown) => Promise<unknown> };
type SeamSdkOutcome = { response?: { statusCode?: unknown }; $metadata?: { httpStatusCode?: unknown } };

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
  for (const segment of target.pathname.split('/').filter(Boolean)) {
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
  const clientPrototype = BedrockRuntimeClient.prototype as { send?: unknown };
  if (typeof clientPrototype.send !== 'function') {
    throw seamError('BedrockRuntimeClient.prototype.send is not callable');
  }
  const originalSend = clientPrototype.send as SeamSend;
  const handlerStates = new WeakMap<object, 'guarded' | 'failed'>();
  clientPrototype.send = function (this: BedrockRuntimeClient, ...args: unknown[]): unknown {
    const requestHandler = (this.config as { requestHandler?: SeamRequestHandler } | undefined)?.requestHandler;
    if (requestHandler && handlerStates.get(requestHandler) === 'failed') {
      throw seamError('Bedrock request handler handle is not writable');
    }
    const originalHandle = requestHandler?.handle;
    if (!requestHandler || typeof originalHandle !== 'function') {
      throw seamError('resolved Bedrock request handler has no callable handle');
    }
    if (handlerStates.get(requestHandler) !== 'guarded') {
      const wrapped = async (request: unknown, options?: unknown): Promise<unknown> => {
        gateSecondWireAttempt(observation);
        try {
          const result = await originalHandle.call(requestHandler, request, options);
          observation.status ??= finiteInteger((result as SeamSdkOutcome | undefined)?.response?.statusCode);
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
        observation.status ??= finiteInteger((error as SeamSdkOutcome | undefined)?.$metadata?.httpStatusCode);
        throw error;
      });
    }
    return pending;
  };
  globalThis.fetch = new Proxy(globalThis.fetch, {
    async apply(target, thisArg, [input, init]) {
      // One native Request(input, init) snapshot: validated, gated, transmitted; redirect forced by init.
      let snapshot: Request;
      if (input instanceof Request) {
        if (types.isProxy(input)) {
          throw seamError('request input must not be a Proxy');
        }
        const intrinsicUrl = Reflect.get(Request.prototype, 'url', input) as string;
        if (input.url !== intrinsicUrl) {
          throw seamError('request input url is not internally consistent');
        }
        snapshot = new Request(input, init);
        if (snapshot.url !== intrinsicUrl) {
          throw seamError('request input url is not internally consistent');
        }
      } else if (typeof input === 'string' || input instanceof URL) {
        const wireTarget = new URL(typeof input === 'string' ? input : URL.prototype.toString.call(input));
        assertAllowedTarget(baseOrigin, basePathname, wireTarget, 'request url');
        snapshot = new Request(wireTarget, init);
      } else {
        throw seamError('fetch input must be a string, URL or Request');
      }
      assertAllowedTarget(baseOrigin, basePathname, new URL(snapshot.url), 'request url');
      gateSecondWireAttempt(observation);
      try {
        const response = await Reflect.apply(target, thisArg, [snapshot, { redirect: 'error' }]);
        observation.status = response.status;
        return response;
      } catch (error) {
        observation.networkFailure = true;
        throw error;
      }
    },
  });
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
