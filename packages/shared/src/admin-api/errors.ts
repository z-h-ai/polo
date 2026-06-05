/**
 * Custom error classes for the Admin API client.
 *
 * Error hierarchy:
 *   AdminApiError (base)
 *     ├─ AuthenticationError      (HTTP 401)
 *     ├─ AccountDisabledError     (HTTP 403)
 *     ├─ DuplicateRequestError    (HTTP 409)
 *     ├─ AdminApiUnavailableError (network failure)
 *     └─ AdminApiTimeoutError     (AbortController timeout)
 *   ConfigurationError            (missing ADMIN_API_URL)
 */

export class AdminApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'AdminApiError';
    this.statusCode = statusCode;
  }
}

export class AuthenticationError extends AdminApiError {
  constructor(message = 'Admin API: authentication failed (HTTP 401)') {
    super(message, 401);
    this.name = 'AuthenticationError';
  }
}

export class AccountDisabledError extends AdminApiError {
  constructor(message = 'Admin API: account is disabled (HTTP 403)') {
    super(message, 403);
    this.name = 'AccountDisabledError';
  }
}

export class DuplicateRequestError extends AdminApiError {
  constructor(message = 'Admin API: duplicate requestId (HTTP 409)') {
    super(message, 409);
    this.name = 'DuplicateRequestError';
  }
}

export class AdminApiUnavailableError extends Error {
  constructor(message = 'Admin API: service unavailable (network error)') {
    super(message);
    this.name = 'AdminApiUnavailableError';
  }
}

export class AdminApiTimeoutError extends Error {
  constructor(message = 'Admin API: request timed out') {
    super(message);
    this.name = 'AdminApiTimeoutError';
  }
}

export class ConfigurationError extends Error {
  constructor(message = 'ADMIN_API_URL environment variable is not set') {
    super(message);
    this.name = 'ConfigurationError';
  }
}
