/**
 * Relay-client configuration (POL-237, PRD v1.6 §⑥ v1.2 环境变量策略).
 *
 * The relay address is runtime configuration — never a hardcoded domain:
 *
 *   1. Runtime override (admin-issued / renderer IPC via setRelayUrlOverride)
 *      — highest priority, "admin 下发覆盖".
 *   2. `POLO_RELAY_URL` environment variable (repo precedent: env beats stored
 *      config, see POLO_AI_RPC_HOST handling in main/index.ts).
 *   3. Local settings file `<CONFIG_DIR>/relay.json` (`relayUrl` key), editable
 *      by the future settings UI / pairing flow (M1-6).
 *
 * When no URL resolves, getRelayUrl() returns null and the relay link stays
 * disabled (status offline; no connection attempts are made).
 *
 * The same file also holds the stable `deviceId` used as the relay persona
 * (`mac:<deviceId>`), generated once on first use. Device binding of that id
 * to the user happens admin-side (relay check-access, M1-4) — out of scope here.
 */

import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'crypto'
import { CONFIG_DIR } from '@polo-ai/shared/config/paths'

export const RELAY_URL_ENV_VAR = 'POLO_RELAY_URL'

const RELAY_SETTINGS_FILE = join(CONFIG_DIR, 'relay.json')

export interface RelaySettingsFile {
  /** Outbound relay endpoint, e.g. `wss://relay.example.com`. */
  relayUrl?: string
  /** Stable per-install device id for the `mac:<deviceId>` relay persona. */
  deviceId?: string
}

export interface RelayClientConfig {
  /** Resolved relay endpoint (ws:// / wss://), or null when not configured. */
  relayUrl: string | null
  /** Stable per-install device id (`mac:<id>` persona key). */
  deviceId: string
}

// ---------------------------------------------------------------------------
// Settings file (electron-owned; shared package schema untouched)
// ---------------------------------------------------------------------------

export function loadRelaySettings(configDir: string = CONFIG_DIR): RelaySettingsFile {
  const file = join(configDir, 'relay.json')
  try {
    if (!existsSync(file)) return {}
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    return {
      relayUrl: typeof record['relayUrl'] === 'string' ? record['relayUrl'] : undefined,
      deviceId: typeof record['deviceId'] === 'string' ? record['deviceId'] : undefined,
    }
  } catch {
    // Corrupt file — start fresh; next save rewrites it.
    return {}
  }
}

export function saveRelaySettings(
  settings: RelaySettingsFile,
  configDir: string = CONFIG_DIR,
): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'relay.json'), JSON.stringify(settings, null, 2) + '\n', 'utf8')
  } catch {
    // Best effort — a read-only config dir must not crash the app.
  }
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/** Normalizes user/admin-supplied addresses to a WS endpoint. Returns null when unusable. */
export function normalizeRelayUrl(raw: string | undefined | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = trimmed.startsWith('ws://') || trimmed.startsWith('wss://')
    ? trimmed
    : trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed.replace(/^http/, 'ws')
      : null
  if (!withScheme) return null
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
    if (!url.host) return null
    // Relay upgrades at "/" (any path is a WS route except /healthz) — strip a
    // trailing slash so the endpoint prints cleanly.
    return withScheme.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * Resolution chain: runtime override (admin) → env `POLO_RELAY_URL` →
 * local settings file. First usable value wins.
 */
export function resolveRelayUrl(
  env: Record<string, string | undefined>,
  settings: RelaySettingsFile,
  override?: string | null,
): string | null {
  return normalizeRelayUrl(override)
    ?? normalizeRelayUrl(env[RELAY_URL_ENV_VAR])
    ?? normalizeRelayUrl(settings.relayUrl)
}

/** Stable per-install device id — generates and persists one on first call. */
export function getOrCreateDeviceId(settings: RelaySettingsFile, configDir: string = CONFIG_DIR): string {
  if (settings.deviceId) return settings.deviceId
  const deviceId = randomUUID()
  saveRelaySettings({ ...settings, deviceId }, configDir)
  return deviceId
}

/**
 * Full config load. Resolution chain: admin runtime override →
 * env `POLO_RELAY_URL` → local settings file. `override`, when provided,
 * replaces the module-level admin override (test seam). Returns null URL when
 * the relay is not configured — callers must treat that as "relay link
 * disabled" rather than an error.
 */
export function loadRelayClientConfig(
  env: Record<string, string | undefined> = process.env,
  configDir: string = CONFIG_DIR,
  override?: string | null,
): RelayClientConfig {
  const settings = loadRelaySettings(configDir)
  const effectiveOverride = override !== undefined ? override : getRelayUrlOverride()
  return {
    relayUrl: resolveRelayUrl(env, settings, effectiveOverride),
    deviceId: getOrCreateDeviceId(settings, configDir),
  }
}

// ---------------------------------------------------------------------------
// Runtime override (admin 下发)
// ---------------------------------------------------------------------------

let runtimeOverride: string | null | undefined = undefined

/**
 * Set (or clear with null) the admin-issued relay URL. Takes precedence over
 * env and local settings on the next loadRelayClientConfig() call.
 */
export function setRelayUrlOverride(url: string | null): void {
  runtimeOverride = url
}

/** Current admin override, if any. */
export function getRelayUrlOverride(): string | null | undefined {
  return runtimeOverride
}
