import { AdminEntityIdSchema } from '../admin/schemas.ts'
import type {
  LocalAppArchitecture,
  LocalAppPlatform,
  PoloAppManifest,
} from './local-apps.ts'

const VERSION_PATTERN = /^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,126}[0-9A-Za-z])?$/
const VALID_RUNTIMES = new Set(['static', 'python', 'js'])
const VALID_PLATFORMS = new Set<LocalAppPlatform>(['darwin', 'win32', 'linux'])
const VALID_ARCHITECTURES = new Set<LocalAppArchitecture>(['arm64', 'x64'])
const SUPPORTED_PERMISSIONS = new Set<string>()

export type PoloAppManifestValidationCode =
  | 'INVALID_MANIFEST'
  | 'PLATFORM_MISMATCH'
  | 'ARCH_MISMATCH'

export class PoloAppManifestValidationError extends Error {
  readonly code: PoloAppManifestValidationCode
  readonly details?: Record<string, unknown>

  constructor(
    code: PoloAppManifestValidationCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'PoloAppManifestValidationError'
    this.code = code
    this.details = details
  }
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new PoloAppManifestValidationError('INVALID_MANIFEST', message, details)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  if (typeof value !== 'string' || (!options.allowEmpty && value.length === 0)) {
    return invalid(`polo-app.json field "${field}" must be a non-empty string`)
  }
  if (value.includes('\0')) {
    return invalid(`polo-app.json field "${field}" contains a NUL byte`)
  }
  if (value.length > (options.maxLength ?? 2048)) {
    return invalid(`polo-app.json field "${field}" is too long`)
  }
  return value
}

function requireStringArray(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return invalid(`polo-app.json field "${field}" must be ${allowEmpty ? 'an' : 'a non-empty'} string array`)
  }
  if (value.length > 128) {
    return invalid(`polo-app.json field "${field}" has too many items`)
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`))
}

export function assertSafeLocalAppRelativePath(value: string, field: string): string {
  const portable = value.replaceAll('\\', '/')
  if (
    portable.startsWith('/')
    || /^[A-Za-z]:\//.test(portable)
    || portable.split('/').includes('..')
  ) {
    return invalid(`polo-app.json field "${field}" must stay inside the bundle`, { value })
  }
  const cleaned = portable.split('/').filter(segment => segment !== '' && segment !== '.').join('/')
  if (!cleaned) return '.'
  return cleaned
}

function validateHttpPath(value: unknown, field: string): string {
  const path = requireString(value, field)
  if (!path.startsWith('/') || path.startsWith('//')) {
    return invalid(`polo-app.json field "${field}" must be an absolute HTTP path beginning with "/"`)
  }
  try {
    const parsed = new URL(path, 'http://127.0.0.1')
    if (parsed.origin !== 'http://127.0.0.1' || parsed.pathname.includes('\0')) {
      return invalid(`polo-app.json field "${field}" is not a valid local HTTP path`)
    }
  } catch {
    return invalid(`polo-app.json field "${field}" is not a valid local HTTP path`)
  }
  return path
}

function validateEnumArray<T extends string>(
  value: unknown,
  field: string,
  allowed: Set<T>,
): T[] | undefined {
  if (value == null) return undefined
  const values = requireStringArray(value, field)
  for (const item of values) {
    if (!allowed.has(item as T)) {
      return invalid(`polo-app.json field "${field}" contains unsupported value "${item}"`)
    }
  }
  return [...new Set(values as T[])]
}

export function validatePoloAppManifestContract(
  raw: unknown,
  host?: { platform: LocalAppPlatform; arch: LocalAppArchitecture },
): PoloAppManifest {
  if (!isPlainObject(raw)) invalid('polo-app.json must contain a JSON object')
  if (raw.schemaVersion !== 1) {
    invalid('Unsupported polo-app.json schemaVersion; expected 1', {
      schemaVersion: raw.schemaVersion,
    })
  }

  const appIdResult = AdminEntityIdSchema.safeParse(raw.appId)
  if (!appIdResult.success) {
    invalid('polo-app.json field "appId" must satisfy the Admin entity ID contract')
  }
  const appId = appIdResult.data

  const version = requireString(raw.version, 'version', { maxLength: 128 })
  if (!VERSION_PATTERN.test(version) || version === '.' || version === '..') {
    invalid('polo-app.json version contains unsupported characters', { version })
  }

  const runtime = requireString(raw.runtime, 'runtime')
  if (!VALID_RUNTIMES.has(runtime)) {
    invalid(`Unsupported runtime "${runtime}"; expected static, python, or js`)
  }

  const entry = requireStringArray(raw.entry, 'entry')
  entry[0] = assertSafeLocalAppRelativePath(entry[0]!, 'entry[0]')
  if (entry[0] === '.') invalid('polo-app.json entry[0] must identify a file or directory')

  const platforms = validateEnumArray(raw.platforms, 'platforms', VALID_PLATFORMS)
  const architectures = validateEnumArray(raw.architectures, 'architectures', VALID_ARCHITECTURES)
  if (host && platforms && !platforms.includes(host.platform)) {
    throw new PoloAppManifestValidationError(
      'PLATFORM_MISMATCH',
      `Bundle does not support ${host.platform}; supported platforms: ${platforms.join(', ')}`,
      { expected: host.platform, supported: platforms },
    )
  }
  if (host && architectures && !architectures.includes(host.arch)) {
    throw new PoloAppManifestValidationError(
      'ARCH_MISMATCH',
      `Bundle does not support ${host.arch}; supported architectures: ${architectures.join(', ')}`,
      { expected: host.arch, supported: architectures },
    )
  }

  const permissions = requireStringArray(raw.permissions, 'permissions', true)
  for (const permission of permissions) {
    if (!SUPPORTED_PERMISSIONS.has(permission)) {
      invalid(`polo-app.json requests unsupported permission "${permission}"`)
    }
  }
  const name = raw.name == null ? undefined : requireString(raw.name, 'name', { maxLength: 200 })
  let startTimeoutMs: number | undefined
  if (raw.startTimeoutMs != null) {
    if (
      typeof raw.startTimeoutMs !== 'number'
      || !Number.isInteger(raw.startTimeoutMs)
      || raw.startTimeoutMs < 1_000
      || raw.startTimeoutMs > 120_000
    ) {
      invalid('polo-app.json startTimeoutMs must be an integer between 1000 and 120000')
    }
    startTimeoutMs = raw.startTimeoutMs
  }

  return {
    schemaVersion: 1,
    appId,
    version,
    ...(name ? { name } : {}),
    runtime: runtime as PoloAppManifest['runtime'],
    entry,
    healthcheck: validateHttpPath(raw.healthcheck, 'healthcheck'),
    webPath: validateHttpPath(raw.webPath, 'webPath'),
    permissions,
    ...(platforms ? { platforms } : {}),
    ...(architectures ? { architectures } : {}),
    ...(startTimeoutMs ? { startTimeoutMs } : {}),
  }
}
