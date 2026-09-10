/**
 * Host single-attempt transport observation seam (POO-69).
 *
 * A one-shot Host worker installs this BEFORE pi-ai is loaded (POO-68 owns the
 * bootstrap). One request-local `TransportObservation` covers both transports:
 * the saved-original `globalThis.fetch` gets a fail-closed URL policy wrapper
 * (always `redirect: 'error'`), and the shared `BedrockRuntimeClient` send
 * wrapper guards each instance's resolved `config.requestHandler.handle` —
 * the AWS retry middleware's per-wire-attempt entry point. The second wire
 * attempt throws an internal `RetryBlockedError` before the original
 * transport runs; observations hold only counts and numeric status, never
 * provider request/response content.
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

class RetryBlockedError extends Error {
  constructor() {
    super(`${SEAM_ERROR_PREFIX} second wire attempt blocked`);
    this.name = 'RetryBlockedError';
  }
}

function seamError(reason: string): Error {
  return new Error(`${SEAM_ERROR_PREFIX} ${reason}`);
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) ? value : undefined;
}

/** Comparable origin: lowercase protocol, bracket-less lowercase hostname, effective port. */
function originKeyOf(url: URL): string {
  const hostname = url.hostname.startsWith('[')
    ? url.hostname.slice(1, -1).toLowerCase()
    : url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol.toLowerCase()}//${hostname}:${port}`;
}

function assertHttpPolicy(url: URL, label: string): void {
  const badScheme = url.protocol !== 'http:' && url.protocol !== 'https:';
  const leaky = url.username !== '' || url.password !== '' || url.hash !== '';
  if (badScheme || leaky) throw seamError(`${label} must be http(s) without userinfo or fragment`);
}

/**
 * Decode each raw pathname segment exactly once and reject decode failures,
 * dot segments and decoded `/` or `\\` (encoded traversal cannot survive the
 * canonical URL the WHATWG parser hands us).
 */
function assertDecodablePath(pathname: string, label: string): void {
  for (const segment of pathname.split('/')) {
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

function assertPathAllowed(basePathname: string, requestPathname: string): void {
  if (requestPathname === basePathname) return;
  const prefix = basePathname.endsWith('/') ? basePathname : `${basePathname}/`;
  if (!requestPathname.startsWith(prefix)) {
    throw seamError('request path is not the base path or a descendant of it');
  }
}

function observableTargetUrl(input: unknown): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw seamError('fetch input must be a string, URL or Request');
}

function installBedrockSendSeam(observation: TransportObservation): void {
  const clientPrototype = BedrockRuntimeClient.prototype as { send?: unknown };
  if (typeof clientPrototype.send !== 'function') {
    throw seamError('BedrockRuntimeClient.prototype.send is not callable');
  }
  const originalSend = clientPrototype.send as (this: BedrockRuntimeClient, ...args: unknown[]) => unknown;
  const guardedHandlers = new WeakSet<object>();
  clientPrototype.send = function (this: BedrockRuntimeClient, ...args: unknown[]): unknown {
    const candidate = (this.config as { requestHandler?: unknown } | undefined)?.requestHandler as
      | { handle?: unknown }
      | undefined;
    if (!candidate || typeof candidate.handle !== 'function') {
      throw seamError('resolved Bedrock request handler has no callable handle');
    }
    const requestHandler = candidate as { handle: (request: unknown, options?: unknown) => Promise<unknown> };
    if (!guardedHandlers.has(requestHandler)) {
      const originalHandle = requestHandler.handle;
      const wrapped = async (request: unknown, options?: unknown): Promise<unknown> => {
        observation.attempts += 1;
        if (observation.attempts > 1) {
          observation.retryBlocked = true;
          throw new RetryBlockedError();
        }
        try {
          const result = await originalHandle.call(requestHandler, request, options);
          const wireStatus = finiteInteger((result as { response?: { statusCode?: unknown } } | undefined)?.response?.statusCode);
          if (wireStatus !== undefined) observation.status = wireStatus;
          return result;
        } catch (error) {
          observation.networkFailure = true;
          throw error;
        }
      };
      // Atomic install: assign the built wrapper, verify, then mark — a failed install stays unmarked and fails closed.
      try { requestHandler.handle = wrapped; } catch { throw seamError('Bedrock request handler handle is not writable'); }
      if (requestHandler.handle !== wrapped) throw seamError('Bedrock request handler handle is not writable');
      guardedHandlers.add(requestHandler);
    }
    const pending = originalSend.apply(this, args) as Promise<unknown> | undefined;
    if (typeof pending?.then === 'function') {
      return pending.then(undefined, (error: unknown) => {
        observation.sdkException = true;
        const metadataStatus = finiteInteger(
          (error as { $metadata?: { httpStatusCode?: unknown } } | undefined)?.$metadata?.httpStatusCode,
        );
        if (observation.status === undefined && metadataStatus !== undefined) observation.status = metadataStatus;
        throw error;
      });
    }
    return pending;
  };
}

export function installTransportObservation(baseUrl: URL): InstalledTransportObservation {
  assertHttpPolicy(baseUrl, 'base url');
  assertDecodablePath(baseUrl.pathname, 'base url');
  const baseOrigin = originKeyOf(baseUrl);
  const basePathname = baseUrl.pathname;
  const observation: TransportObservation = {
    attempts: 0,
    networkFailure: false,
    retryBlocked: false,
    sdkException: false,
  };
  const originalFetch = globalThis.fetch;
  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = observableTargetUrl(input);
    assertHttpPolicy(target, 'request url');
    assertDecodablePath(target.pathname, 'request url');
    if (originKeyOf(target) !== baseOrigin) {
      throw seamError('request origin differs from the installed base origin');
    }
    assertPathAllowed(basePathname, target.pathname);
    observation.attempts += 1;
    if (observation.attempts > 1) {
      observation.retryBlocked = true;
      throw new RetryBlockedError();
    }
    try {
      const response = await originalFetch.call(globalThis, input, { ...init, redirect: 'error' });
      observation.status = response.status;
      return response;
    } catch (error) {
      observation.networkFailure = true;
      throw error;
    }
  };
  // Patch both globals only after all preconditions passed — a send-check failure leaves both untouched.
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
  if (flags.deadlineExpired) return 'deadline_exceeded';
  if (observation.retryBlocked || observation.attempts > 1) return 'retry_blocked';
  if (observation.status === 401 || observation.status === 403) return 'provider_rejected_credentials';
  if (observation.networkFailure || (flags.providerFailed && typeof observation.status === 'number')) {
    return 'provider_request_failed';
  }
  if (observation.sdkException || flags.providerFailed) return 'provider_error_terminal';
  return undefined;
}
