import {
  assertSafeLocalAppRelativePath,
  PoloAppManifestValidationError,
  validatePoloAppManifestContract,
  type LocalAppArchitecture,
  type LocalAppPlatform,
  type PoloAppManifest,
} from '@polo-ai/shared/protocol'
import { LocalAppRuntimeError } from './runtime-error'

function mapManifestError(error: unknown): never {
  if (error instanceof PoloAppManifestValidationError) {
    throw new LocalAppRuntimeError(error.code, error.message, error.details)
  }
  throw error
}

export function assertSafeRelativePath(value: string, field: string): string {
  try {
    return assertSafeLocalAppRelativePath(value, field)
  } catch (error) {
    return mapManifestError(error)
  }
}

export function validatePoloAppManifest(
  raw: unknown,
  host: { platform: LocalAppPlatform; arch: LocalAppArchitecture },
): PoloAppManifest {
  try {
    return validatePoloAppManifestContract(raw, host)
  } catch (error) {
    return mapManifestError(error)
  }
}
