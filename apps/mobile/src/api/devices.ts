// Device binding endpoints for the phone side of the pairing flow (POL-16).
//
// Wire shapes (verified against polo-admin @ deb31d86: src/app/api/devices/*/
// route.ts + src/lib/devices/{service,pairing}.ts):
//   POST /api/devices/pairing-code   (Bearer JWT; Mac-side issuer, wrapped here
//        for contract completeness)  body { macDeviceId }
//        -> { code, macDeviceId, expiresAt, expiresInSeconds }
//        (re-issuing supersedes the previous live code of the same Mac)
//   POST /api/devices/bind           (Bearer JWT; userId only ever comes from
//        the token server-side)      body { code, name, platform, pushToken? }
//        -> { device: DeviceView, reused }
//        reused=true means the (userId, macDeviceId) row existed (revoked
//        included) and was revived — the POL-8 复用契约: re-pairing the same
//        phone to the same Mac refreshes the original row.
//   GET  /api/devices/list           (Bearer JWT)
//        -> { devices: DeviceView[] }  active bindings only, newest first
//   POST /api/devices/revoke         (Bearer JWT; owner-scoped, idempotent)
//        body { deviceId } or { macDeviceId } (exactly one)
//        -> { revokedCount, devices: DeviceView[] }
//
// DeviceView (admin toDeviceView): id / name / platform / macDeviceId /
// pushToken / lastSeenAt (ISO | null) / boundAt (ISO) / revoked.
//
// Error codes pass through verbatim as ApiError (client.ts contract); the UI
// layer maps them to copy — nothing is swallowed or translated here:
//   pairing_code_invalid / pairing_code_expired / pairing_code_consumed (401)
//   device_already_bound / device_bind_limit_reached (409, details.limit)
//   forbidden (403 — code issued by another account), not_found (404),
//   validation_error (400), rate_limited (429).
//
// Note on 401 pairing codes: client.ts keeps business 401s (non-auth codes)
// OUT of the refresh/replay chain — the session survives a stale pairing code.

import { apiClient } from './client';
import type { ApiClient } from './client';

/** Admin deviceBindSchema platform enum. */
export type DevicePlatform = 'ios' | 'android';

/** Admin pairingCodeSchema: exactly six digits. */
export const PAIRING_CODE_PATTERN = /^\d{6}$/;

/** Admin toDeviceView — the shared bind/list/revoke response row. */
export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  macDeviceId: string;
  pushToken: string | null;
  lastSeenAt: string | null;
  boundAt: string;
  revoked: boolean;
}

/** pairing-code issue result — the plaintext code appears exactly once. */
export interface PairingCodeIssueView {
  code: string;
  macDeviceId: string;
  /** Epoch ms — decoded from the admin ISO timestamp for countdown math. */
  expiresAtMs: number;
  /** Admin TTL: 300s. Informational; the server decides validity. */
  expiresInSeconds: number;
}

/** bind result — reused=true marks the revived original row (复用契约). */
export interface DeviceBindResult {
  device: DeviceView;
  reused: boolean;
}

/** revoke result — revokedCount=0 happens on idempotent replays. */
export interface DeviceRevokeResult {
  revokedCount: number;
  devices: DeviceView[];
}

export interface DevicesApi {
  /** Mac-side issuer (contract completeness; the phone does not call it). */
  issuePairingCode(input: { macDeviceId: string }): Promise<PairingCodeIssueView>;
  /** 原子核销配对码并写入/复用绑定行. pushToken stays unset until P3. */
  bind(input: {
    code: string;
    name: string;
    platform: DevicePlatform;
    pushToken?: string;
  }): Promise<DeviceBindResult>;
  /** 本人活跃绑定，最新绑定在前. */
  list(): Promise<DeviceView[]>;
  /** 属主撤销（幂等）：deviceId 或 macDeviceId 二选一. */
  revoke(input: { deviceId?: string; macDeviceId?: string }): Promise<DeviceRevokeResult>;
}

interface DeviceViewWire {
  id?: unknown;
  name?: unknown;
  platform?: unknown;
  macDeviceId?: unknown;
  pushToken?: unknown;
  lastSeenAt?: unknown;
  boundAt?: unknown;
  revoked?: unknown;
}

function toDeviceView(data: DeviceViewWire): DeviceView {
  if (
    typeof data.id !== 'string' ||
    typeof data.macDeviceId !== 'string' ||
    typeof data.boundAt !== 'string'
  ) {
    throw new Error('Admin response is missing device fields');
  }
  return {
    id: data.id,
    name: typeof data.name === 'string' ? data.name : '',
    platform: typeof data.platform === 'string' ? data.platform : '',
    macDeviceId: data.macDeviceId,
    pushToken: typeof data.pushToken === 'string' ? data.pushToken : null,
    lastSeenAt: typeof data.lastSeenAt === 'string' ? data.lastSeenAt : null,
    boundAt: data.boundAt,
    revoked: data.revoked === true,
  };
}

function toIsoEpochMs(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function readDevicesArray(data: unknown): DeviceView[] {
  const record = (data && typeof data === 'object' ? data : {}) as { devices?: unknown };
  if (!Array.isArray(record.devices)) {
    throw new Error('Admin response is missing the devices array');
  }
  return record.devices.map((row) => toDeviceView(row as DeviceViewWire));
}

export function createDevicesApi(
  client: Pick<ApiClient, 'request' | 'post'> = apiClient,
): DevicesApi {
  return {
    async issuePairingCode({ macDeviceId }) {
      const data = await client.post<{
        code?: unknown;
        macDeviceId?: unknown;
        expiresAt?: unknown;
        expiresInSeconds?: unknown;
      }>('/api/devices/pairing-code', { macDeviceId });
      if (typeof data.code !== 'string') {
        throw new Error('Admin response is missing the pairing code');
      }
      return {
        code: data.code,
        macDeviceId: typeof data.macDeviceId === 'string' ? data.macDeviceId : '',
        expiresAtMs: toIsoEpochMs(data.expiresAt),
        expiresInSeconds: typeof data.expiresInSeconds === 'number' ? data.expiresInSeconds : 0,
      };
    },

    async bind({ code, name, platform, pushToken }) {
      const data = await client.post<{ device?: unknown; reused?: unknown }>('/api/devices/bind', {
        code,
        name,
        platform,
        ...(pushToken !== undefined ? { pushToken } : {}),
      });
      const record = (data && typeof data === 'object' ? data : {}) as {
        device?: unknown;
        reused?: unknown;
      };
      return {
        device: toDeviceView((record.device ?? {}) as DeviceViewWire),
        reused: record.reused === true,
      };
    },

    async list() {
      const data = await client.request<unknown>('/api/devices/list');
      return readDevicesArray(data);
    },

    async revoke({ deviceId, macDeviceId }) {
      // Admin deviceRevokeSchema: exactly one of the two keys.
      const data = await client.post<{ revokedCount?: unknown; devices?: unknown }>(
        '/api/devices/revoke',
        deviceId !== undefined ? { deviceId } : { macDeviceId },
      );
      const record = (data && typeof data === 'object' ? data : {}) as { revokedCount?: unknown };
      return {
        revokedCount: typeof record.revokedCount === 'number' ? record.revokedCount : 0,
        devices: readDevicesArray(data),
      };
    },
  };
}

/** App-wide singleton on the shared api client (attaches the phone JWT). */
export const devicesApi = createDevicesApi();
