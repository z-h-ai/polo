// POL-16 unit tests for the devices api layer (bun test, mocked client).
//
// Covers: request shapes (paths + bodies for all four endpoints), wire->view
// validation, and verbatim pass-through of admin error codes per the card's
// mock matrix: bind 401 码过期/已核销 / 409 超上限 / 409 重复绑定 / 403 跨账号
// / 成功写入（含 reused 复用契约）, revoke 幂等 + 列表刷新数据, list 数组.

import { describe, expect, test } from 'bun:test';

import { ApiError } from '../client';
import { createDevicesApi } from '../devices';

interface RecordedRequest {
  kind: 'request' | 'post';
  path: string;
  body?: unknown;
}

function makeClient(handler: (call: RecordedRequest) => unknown) {
  const calls: RecordedRequest[] = [];
  const client = {
    request: async <T>(path: string): Promise<T> => {
      const call: RecordedRequest = { kind: 'request', path };
      calls.push(call);
      return handler(call) as T;
    },
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      const call: RecordedRequest = { kind: 'post', path, body };
      calls.push(call);
      return handler(call) as T;
    },
  };
  return { client, calls };
}

const DEVICE = {
  id: 'dev-1',
  name: 'Douglas 的 iPhone',
  platform: 'ios',
  macDeviceId: 'mac-7F3A-92C1-0D8E',
  macName: '书房的 MacBook Pro',
  pushToken: null,
  lastSeenAt: '2026-10-17T08:00:00.000Z',
  boundAt: '2026-10-17T07:00:00.000Z',
  revoked: false,
};

describe('devicesApi.issuePairingCode', () => {
  test('POSTs { macDeviceId } and maps the issue view', async () => {
    const { client, calls } = makeClient(() => ({
      code: '246810',
      macDeviceId: 'mac-7F3A-92C1-0D8E',
      expiresAt: '2026-10-17T08:05:00.000Z',
      expiresInSeconds: 300,
    }));
    const api = createDevicesApi(client);

    const view = await api.issuePairingCode({ macDeviceId: 'mac-7F3A-92C1-0D8E' });

    expect(calls[0]?.kind).toBe('post');
    expect(calls[0]?.path).toBe('/api/devices/pairing-code');
    expect(calls[0]?.body).toEqual({ macDeviceId: 'mac-7F3A-92C1-0D8E' });
    expect(view).toEqual({
      code: '246810',
      macDeviceId: 'mac-7F3A-92C1-0D8E',
      expiresAtMs: Date.parse('2026-10-17T08:05:00.000Z'),
      expiresInSeconds: 300,
    });
  });

  test('a response without the code throws (defensive shape check)', async () => {
    const { client } = makeClient(() => ({ macDeviceId: 'mac-x' }));
    const api = createDevicesApi(client);
    expect(api.issuePairingCode({ macDeviceId: 'mac-x' })).rejects.toThrow(
      'Admin response is missing the pairing code',
    );
  });
});

describe('devicesApi.bind', () => {
  const input = { code: '246810', name: 'Douglas 的 iPhone', platform: 'ios' as const };

  test('POSTs { code, name, platform } (pushToken omitted until P3) and returns the device', async () => {
    const { client, calls } = makeClient(() => ({ device: DEVICE, reused: false }));
    const api = createDevicesApi(client);

    const result = await api.bind(input);

    expect(calls[0]?.path).toBe('/api/devices/bind');
    expect(calls[0]?.body).toEqual({ code: '246810', name: 'Douglas 的 iPhone', platform: 'ios' });
    expect(result.device).toEqual(DEVICE);
    expect(result.reused).toBe(false);
  });

  test('reused=true passes through（同手机重绑同 Mac 复用原行）', async () => {
    const { client } = makeClient(() => ({ device: DEVICE, reused: true }));
    const api = createDevicesApi(client);
    const result = await api.bind(input);
    expect(result.reused).toBe(true);
  });

  test('pushToken is forwarded when provided (P3 预留字段)', async () => {
    const { client, calls } = makeClient(() => ({ device: DEVICE, reused: false }));
    const api = createDevicesApi(client);
    await api.bind({ ...input, pushToken: 'tok-1' });
    expect(calls[0]?.body).toEqual({
      code: '246810',
      name: 'Douglas 的 iPhone',
      platform: 'ios',
      pushToken: 'tok-1',
    });
  });

  test('401 pairing_code_expired 错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 401, errorCode: 'pairing_code_expired' });
    });
    const api = createDevicesApi(client);
    expect(api.bind(input)).rejects.toMatchObject({
      name: 'ApiError',
      errorCode: 'pairing_code_expired',
      status: 401,
    });
  });

  test('401 pairing_code_consumed（已核销）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 401, errorCode: 'pairing_code_consumed' });
    });
    const api = createDevicesApi(client);
    expect(api.bind(input)).rejects.toMatchObject({ errorCode: 'pairing_code_consumed', status: 401 });
  });

  test('401 pairing_code_invalid 错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 401, errorCode: 'pairing_code_invalid' });
    });
    const api = createDevicesApi(client);
    expect(api.bind(input)).rejects.toMatchObject({ errorCode: 'pairing_code_invalid' });
  });

  test('409 device_bind_limit_reached（超上限）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({
        status: 409,
        errorCode: 'device_bind_limit_reached',
        body: { error: 'device_bind_limit_reached', details: { limit: 5 } },
      });
    });
    const api = createDevicesApi(client);
    expect(api.bind(input)).rejects.toMatchObject({
      errorCode: 'device_bind_limit_reached',
      status: 409,
      body: { details: { limit: 5 } },
    });
  });

  test('409 device_already_bound（重复绑定）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 409, errorCode: 'device_already_bound' });
    });
    const api = createDevicesApi(client);
    expect(api.bind(input)).rejects.toMatchObject({ errorCode: 'device_already_bound', status: 409 });
  });

  test('403 forbidden（跨账号配对码）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 403, errorCode: 'forbidden' });
    });
    const api = createDevicesApi(client);
    expect(api.bind(input)).rejects.toMatchObject({ errorCode: 'forbidden', status: 403 });
  });

  test('a wire payload without the device row throws (defensive shape check)', async () => {
    const { client } = makeClient(() => ({ reused: false }));
    const api = createDevicesApi(client);
    expect(api.bind(input)).rejects.toThrow('Admin response is missing device fields');
  });
});

describe('devicesApi.list', () => {
  test('GETs /api/devices/list and maps the devices array', async () => {
    const { client, calls } = makeClient(() => ({ devices: [DEVICE] }));
    const api = createDevicesApi(client);

    const rows = await api.list();

    expect(calls[0]?.kind).toBe('request');
    expect(calls[0]?.path).toBe('/api/devices/list');
    expect(rows).toEqual([DEVICE]);
  });

  test('macName 可空：缺省/非字符串回退 null（macDisplayName 兜底 macDeviceId）', async () => {
    const { client } = makeClient(() => ({
      devices: [
        { ...DEVICE, macName: undefined },
        { ...DEVICE, id: 'dev-2', macName: 42 },
      ],
    }));
    const api = createDevicesApi(client);

    const rows = await api.list();

    expect(rows).toHaveLength(2);
    expect(rows[0]?.macName).toBeNull();
    expect(rows[1]?.macName).toBeNull();
  });

  test('an empty account maps to []', async () => {
    const { client } = makeClient(() => ({ devices: [] }));
    const api = createDevicesApi(client);
    expect(await api.list()).toEqual([]);
  });

  test('a wire payload without the devices array throws (defensive shape check)', async () => {
    const { client } = makeClient(() => ({}));
    const api = createDevicesApi(client);
    expect(api.list()).rejects.toThrow('Admin response is missing the devices array');
  });
});

describe('devicesApi.revoke', () => {
  test('POSTs exactly { deviceId } when revoking by row id', async () => {
    const { client, calls } = makeClient(() => ({ revokedCount: 1, devices: [DEVICE] }));
    const api = createDevicesApi(client);

    const result = await api.revoke({ deviceId: 'dev-1' });

    expect(calls[0]?.path).toBe('/api/devices/revoke');
    expect(calls[0]?.body).toEqual({ deviceId: 'dev-1' });
    expect(result.revokedCount).toBe(1);
    expect(result.devices).toEqual([DEVICE]);
  });

  test('POSTs { macDeviceId } when revoking by Mac id', async () => {
    const { client, calls } = makeClient(() => ({ revokedCount: 2, devices: [DEVICE] }));
    const api = createDevicesApi(client);
    await api.revoke({ macDeviceId: 'mac-7F3A-92C1-0D8E' });
    expect(calls[0]?.body).toEqual({ macDeviceId: 'mac-7F3A-92C1-0D8E' });
  });

  test('idempotent replay keeps revokedCount=0 透传（不吞计数）', async () => {
    const { client } = makeClient(() => ({ revokedCount: 0, devices: [{ ...DEVICE, revoked: true }] }));
    const api = createDevicesApi(client);
    const result = await api.revoke({ deviceId: 'dev-1' });
    expect(result.revokedCount).toBe(0);
    expect(result.devices[0]?.revoked).toBe(true);
  });

  test('404 not_found（非本人/不存在）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 404, errorCode: 'not_found' });
    });
    const api = createDevicesApi(client);
    expect(api.revoke({ deviceId: 'dev-other' })).rejects.toMatchObject({
      errorCode: 'not_found',
      status: 404,
    });
  });
});
