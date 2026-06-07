/**
 * Admin API HTTP client.
 *
 * Polo AI Server uses this to call Admin API endpoints:
 *   - checkQuota    POST /api/quota/check   (3 s timeout)
 *   - reportUsage   POST /api/quota/usage   (5 s timeout)
 *   - getQuotaStatus GET /api/quota/status
 *
 * Uses Bun-native fetch + AbortController for per-request timeouts.
 * Admin API is treated as an external service (no retry logic here).
 */

import {
  AdminApiError,
  AuthenticationError,
  AccountDisabledError,
  DuplicateRequestError,
  AdminApiUnavailableError,
  AdminApiTimeoutError,
  ConfigurationError,
} from './errors.ts';
import type { QuotaCheckResult, UsageReportInput, UsageReportResult, QuotaStatus } from './types.ts';
import type { OnForceLogout, SessionExpiredEvent } from '../auth/force-logout.ts';

export type { OnForceLogout, SessionExpiredEvent } from '../auth/force-logout.ts';

// ─── default timeouts ─────────────────────────────────────────────────────────

const DEFAULT_CHECK_QUOTA_TIMEOUT_MS = 3_000;
const DEFAULT_REPORT_USAGE_TIMEOUT_MS = 5_000;

// ─── fetch type alias ─────────────────────────────────────────────────────────

/**
 * Minimal fetch signature accepted by AdminApiClient.
 * Using a simple function type instead of `typeof globalThis.fetch`
 * to avoid Bun-specific overloads (e.g. `preconnect`) in the interface.
 */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ─── factory options ─────────────────────────────────────────────────────────

export interface AdminApiClientOptions {
  /** Override the global `fetch` (for testing) */
  fetchFn?: FetchFn;
  /** Called when an authenticated Admin API call returns HTTP 401. */
  onForceLogout?: OnForceLogout;
  /** Timeout for checkQuota (ms). Defaults to 3000. */
  checkQuotaTimeoutMs?: number;
  /** Timeout for reportUsage (ms). Defaults to 5000. */
  reportUsageTimeoutMs?: number;
}

// ─── client class ─────────────────────────────────────────────────────────────

export class AdminApiClient {
  private readonly fetchFn: FetchFn;
  private readonly onForceLogout?: OnForceLogout;
  private readonly checkQuotaTimeoutMs: number;
  private readonly reportUsageTimeoutMs: number;

  constructor(options: AdminApiClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.onForceLogout = options.onForceLogout;
    this.checkQuotaTimeoutMs = options.checkQuotaTimeoutMs ?? DEFAULT_CHECK_QUOTA_TIMEOUT_MS;
    this.reportUsageTimeoutMs = options.reportUsageTimeoutMs ?? DEFAULT_REPORT_USAGE_TIMEOUT_MS;
  }

  // ─── private helpers ───────────────────────────────────────────────────────

  /** Resolve the base URL, stripping any trailing slash. Throws ConfigurationError if unset. */
  private getBaseUrl(): string {
    const raw = process.env.ADMIN_API_URL;
    if (!raw) {
      throw new ConfigurationError();
    }
    return raw.replace(/\/+$/, '');
  }

  /** Build a full endpoint URL from a path segment like '/api/quota/check'. */
  private url(path: string): string {
    return `${this.getBaseUrl()}${path}`;
  }

  /**
   * Execute a fetch with a per-request AbortController timeout.
   * Maps HTTP error codes and network errors to typed error classes.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { jwt: string; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    const { jwt, body, timeoutMs } = options;

    // Resolve URL before entering try/catch so ConfigurationError propagates directly.
    const fullUrl = this.url(path);

    const controller = new AbortController();
    let timerId: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs !== undefined) {
      timerId = setTimeout(() => {
        controller.abort(new AdminApiTimeoutError());
      }, timeoutMs);
    }

    try {
      let response: Response;
      try {
        response = await this.fetchFn(fullUrl, {
          method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        // AbortError → timeout; anything else → unavailable
        if (
          err instanceof AdminApiTimeoutError ||
          (err instanceof DOMException && err.name === 'AbortError') ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          throw new AdminApiTimeoutError();
        }
        throw new AdminApiUnavailableError(
          `Admin API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!response.ok) {
        switch (response.status) {
          case 401:
            await this.notifyForceLogout({ reason: 'token_revoked', requestUrl: fullUrl });
            throw new AuthenticationError();
          case 403:
            throw new AccountDisabledError();
          case 409:
            throw new DuplicateRequestError();
          default:
            throw new AdminApiError(
              `Admin API returned HTTP ${response.status}`,
              response.status,
            );
        }
      }

      return (await response.json()) as T;
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }

  // ─── public API ────────────────────────────────────────────────────────────

  /**
   * POST /api/quota/check
   *
   * Checks whether the user identified by `jwt` is allowed to make a request.
   * Timeout: 3 seconds.
   *
   * @throws {ConfigurationError}       if ADMIN_API_URL is not set
   * @throws {AuthenticationError}      on HTTP 401
   * @throws {AccountDisabledError}     on HTTP 403
   * @throws {AdminApiError}            on other HTTP errors
   * @throws {AdminApiTimeoutError}     on timeout
   * @throws {AdminApiUnavailableError} on network failure
   */
  async checkQuota(jwt: string): Promise<QuotaCheckResult> {
    return this.request<QuotaCheckResult>('POST', '/api/quota/check', {
      jwt,
      body: {},
      timeoutMs: this.checkQuotaTimeoutMs,
    });
  }

  /**
   * POST /api/quota/usage
   *
   * Reports token usage for a completed request.
   * Timeout: 5 seconds.
   *
   * @throws {ConfigurationError}       if ADMIN_API_URL is not set
   * @throws {AuthenticationError}      on HTTP 401
   * @throws {AccountDisabledError}     on HTTP 403
   * @throws {DuplicateRequestError}    on HTTP 409
   * @throws {AdminApiError}            on other HTTP errors
   * @throws {AdminApiTimeoutError}     on timeout
   * @throws {AdminApiUnavailableError} on network failure
   */
  async reportUsage(jwt: string, usage: UsageReportInput): Promise<UsageReportResult> {
    return this.request<UsageReportResult>('POST', '/api/quota/usage', {
      jwt,
      body: usage,
      timeoutMs: this.reportUsageTimeoutMs,
    });
  }

  /**
   * GET /api/quota/status
   *
   * Retrieves the current quota status for the user identified by `jwt`.
   * No dedicated timeout (uses default network timeout).
   *
   * @throws {ConfigurationError}       if ADMIN_API_URL is not set
   * @throws {AuthenticationError}      on HTTP 401
   * @throws {AccountDisabledError}     on HTTP 403
   * @throws {AdminApiError}            on other HTTP errors
   * @throws {AdminApiUnavailableError} on network failure
   */
  async getQuotaStatus(jwt: string): Promise<QuotaStatus> {
    return this.request<QuotaStatus>('GET', '/api/quota/status', { jwt });
  }

  private async notifyForceLogout(event: SessionExpiredEvent): Promise<void> {
    if (!this.onForceLogout) {
      return;
    }

    try {
      await this.onForceLogout(event);
    } catch (error) {
      console.warn(
        '[AdminApiClient] Force logout hook failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

// ─── factory ─────────────────────────────────────────────────────────────────

/**
 * Factory function for creating a new AdminApiClient instance.
 * Useful for testing with a custom fetch implementation.
 */
export function createAdminApiClient(options: AdminApiClientOptions = {}): AdminApiClient {
  return new AdminApiClient(options);
}

// ─── singleton ────────────────────────────────────────────────────────────────

/**
 * Default singleton instance.
 * Uses `process.env.ADMIN_API_URL` and global fetch.
 */
export const adminApiClient = new AdminApiClient();
