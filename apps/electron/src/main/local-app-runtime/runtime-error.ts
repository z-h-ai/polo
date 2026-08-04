import type { LocalAppErrorCode, LocalAppErrorPayload } from '@z-h-ai/shared/protocol'

export class LocalAppRuntimeError extends Error {
  readonly code: LocalAppErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: LocalAppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'LocalAppRuntimeError'
    this.code = code
    this.details = details
  }

  toJSON(): LocalAppErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function asLocalAppRuntimeError(
  error: unknown,
  fallbackCode: LocalAppErrorCode,
  fallbackMessage: string,
): LocalAppRuntimeError {
  if (error instanceof LocalAppRuntimeError) return error
  return new LocalAppRuntimeError(
    fallbackCode,
    error instanceof Error ? error.message : fallbackMessage,
    error instanceof Error && error.stack ? { stack: error.stack } : undefined,
  )
}
