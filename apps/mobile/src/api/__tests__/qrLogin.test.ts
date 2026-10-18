// POL-15 unit tests for the qr login api layer (bun test, mocked client).
//
// Covers: request shapes (scan body, status path + auth flag, confirm/reject
// bodies), wire->view validation, and verbatim pass-through of admin error
// codes for the scan/confirm failure machine: 404 无票据 / 410 确认窗口关闭 /
// 401 已过期 / 400 非法票据(参数校验失败) / 401 secret 不匹配 / 429
// failCount≥5 作废 / 409 已拒绝.

import { describe, expect, test } from 'bun:test';

import { ApiError } from '../client';
import { createQrLoginApi } from '../qrLogin';

interface RecordedRequest {
  path: string;
  options?: { auth?: boolean };
  body?: unknown;
}

function makeClient(handler: (call: RecordedRequest) => unknown) {
  const calls: RecordedRequest[] = [];
  const client = {
    request: async <T>(path: string, options?: { auth?: boolean }): Promise<T> => {
      const call: RecordedRequest = { path, options };
      calls.push(call);
      return handler(call) as T;
    },
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      const call: RecordedRequest = { path, body };
      calls.push(call);
      return handler(call) as T;
    },
  };
  return { client, calls };
}

const SECRET = 'c2VjcmV0LXNlY3JldC12YWx1ZQ';

const VIEW = {
  qrId: 'aGVsbG8td29ybGQteWVhaA',
  status: 'scanned',
  expiresInSeconds: 95,
  requester: { clientType: 'mac', ipMasked: '112.65.*.*', userAgent: 'Mozilla/5.0 PoloMac' },
};

describe('qrLoginApi.getStatus', () => {
  test('GETs /api/auth/qr/status with the qrId query and no Authorization', async () => {
    const { client, calls } = makeClient(() => VIEW);
    const api = createQrLoginApi(client);

    const view = await api.getStatus('aGVsbG8td29ybGQteWVhaA');

    expect(view).toEqual({
      qrId: 'aGVsbG8td29ybGQteWVhaA',
      status: 'scanned',
      expiresInSeconds: 95,
      requester: { clientType: 'mac', ipMasked: '112.65.*.*', userAgent: 'Mozilla/5.0 PoloMac' },
    });
    expect(calls[0]?.path).toBe('/api/auth/qr/status?qrId=aGVsbG8td29ybGQteWVhaA');
    expect(calls[0]?.options).toEqual({ auth: false });
  });

  test('encodes the qrId in the query', async () => {
    const { client, calls } = makeClient(() => ({ ...VIEW, qrId: 'id_with+special/value' }));
    const api = createQrLoginApi(client);
    await api.getStatus('id_with+special/value');
    expect(calls[0]?.path).toBe(`/api/auth/qr/status?qrId=${encodeURIComponent('id_with+special/value')}`);
  });

  test('pending tickets map requester to null', async () => {
    const { client } = makeClient(() => ({
      qrId: VIEW.qrId,
      status: 'pending',
      expiresInSeconds: 120,
      requester: null,
    }));
    const api = createQrLoginApi(client);
    const view = await api.getStatus(VIEW.qrId);
    expect(view.status).toBe('pending');
    expect(view.requester).toBeNull();
  });

  test('404 qr_login_invalid passes through as ApiError', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 404, errorCode: 'qr_login_invalid' });
    });
    const api = createQrLoginApi(client);
    expect(api.getStatus(VIEW.qrId)).rejects.toMatchObject({
      name: 'ApiError',
      errorCode: 'qr_login_invalid',
      status: 404,
    });
  });

  test('a wire payload without a known status throws (defensive shape check)', async () => {
    const { client } = makeClient(() => ({ qrId: VIEW.qrId, status: 'surprise' }));
    const api = createQrLoginApi(client);
    expect(api.getStatus(VIEW.qrId)).rejects.toThrow('Admin response is missing qr status fields');
  });
});

describe('qrLoginApi.confirm / reject', () => {
  test('confirm POSTs { qrId, secret, action: "confirm" } with auth attached', async () => {
    const { client, calls } = makeClient(() => ({ ...VIEW, status: 'confirmed' }));
    const api = createQrLoginApi(client);

    const view = await api.confirm({ qrId: VIEW.qrId, secret: SECRET });

    expect(view.status).toBe('confirmed');
    expect(calls[0]?.path).toBe('/api/auth/qr/confirm');
    expect(calls[0]?.body).toEqual({ qrId: VIEW.qrId, secret: SECRET, action: 'confirm' });
  });

  test('reject POSTs { qrId, secret, action: "reject" }', async () => {
    const { client, calls } = makeClient(() => ({ ...VIEW, status: 'rejected' }));
    const api = createQrLoginApi(client);

    const view = await api.reject({ qrId: VIEW.qrId, secret: SECRET });

    expect(view.status).toBe('rejected');
    expect(calls[0]?.body).toEqual({ qrId: VIEW.qrId, secret: SECRET, action: 'reject' });
  });

  test('过期（401 qr_login_expired）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 401, errorCode: 'qr_login_expired' });
    });
    const api = createQrLoginApi(client);
    expect(api.confirm({ qrId: VIEW.qrId, secret: SECRET })).rejects.toMatchObject({
      errorCode: 'qr_login_expired',
      status: 401,
    });
  });

  test('非法票据（400 validation_error）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 400, errorCode: 'validation_error' });
    });
    const api = createQrLoginApi(client);
    expect(api.confirm({ qrId: VIEW.qrId, secret: SECRET })).rejects.toMatchObject({
      errorCode: 'validation_error',
      status: 400,
    });
  });

  test('secret 不匹配（401 invalid_credentials）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 401, errorCode: 'invalid_credentials' });
    });
    const api = createQrLoginApi(client);
    expect(api.confirm({ qrId: VIEW.qrId, secret: SECRET })).rejects.toMatchObject({
      errorCode: 'invalid_credentials',
      status: 401,
    });
  });

  test('failCount 达限作废（429 qr_login_attempts_exceeded）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 429, errorCode: 'qr_login_attempts_exceeded' });
    });
    const api = createQrLoginApi(client);
    expect(api.reject({ qrId: VIEW.qrId, secret: SECRET })).rejects.toMatchObject({
      errorCode: 'qr_login_attempts_exceeded',
      status: 429,
    });
  });

  test('已被拒绝（409 qr_login_cancelled）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 409, errorCode: 'qr_login_cancelled' });
    });
    const api = createQrLoginApi(client);
    expect(api.confirm({ qrId: VIEW.qrId, secret: SECRET })).rejects.toMatchObject({
      errorCode: 'qr_login_cancelled',
      status: 409,
    });
  });
});

describe('qrLoginApi.scan — 扫码登记（请求端信息来源）', () => {
  const SCAN_VIEW = {
    status: 'scanned' as const,
    requester: {
      clientType: 'mac',
      ipMasked: '112.65.*.*',
      userAgent: 'PoloMac/0.16',
      createdAt: '2026-10-18T03:24:05.000Z',
    },
    expiresInSeconds: 95,
  };

  test('POSTs /api/auth/qr/scan with { qrId, secret } and parses the requester card', async () => {
    const { client, calls } = makeClient(() => SCAN_VIEW);
    const api = createQrLoginApi(client);

    const view = await api.scan({ qrId: VIEW.qrId, secret: SECRET });

    expect(view).toEqual(SCAN_VIEW);
    expect(calls[0]?.path).toBe('/api/auth/qr/scan');
    expect(calls[0]?.body).toEqual({ qrId: VIEW.qrId, secret: SECRET });
  });

  test('requester 字段缺省逐项降级（不渲染半截数据）', async () => {
    const { client } = makeClient(() => ({
      status: 'scanned',
      requester: { clientType: 42 },
      expiresInSeconds: 'soon',
    }));
    const api = createQrLoginApi(client);

    const view = await api.scan({ qrId: VIEW.qrId, secret: SECRET });

    expect(view).toEqual({
      status: 'scanned',
      requester: { clientType: '', ipMasked: null, userAgent: null, createdAt: null },
      expiresInSeconds: 0,
    });
  });

  test('missing requester / 非 scanned 状态抛错（defensive shape check）', async () => {
    const { client } = makeClient(() => ({ status: 'scanned' }));
    const api = createQrLoginApi(client);
    expect(api.scan({ qrId: VIEW.qrId, secret: SECRET })).rejects.toThrow(
      'Admin response is missing qr scan fields',
    );

    const { client: client2 } = makeClient(() => ({ ...SCAN_VIEW, status: 'consumed' }));
    const api2 = createQrLoginApi(client2);
    expect(api2.scan({ qrId: VIEW.qrId, secret: SECRET })).rejects.toThrow(
      'Admin response is missing qr scan fields',
    );
  });

  test('404 无票据（qr_login_invalid）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 404, errorCode: 'qr_login_invalid' });
    });
    const api = createQrLoginApi(client);
    expect(api.scan({ qrId: VIEW.qrId, secret: SECRET })).rejects.toMatchObject({
      name: 'ApiError',
      errorCode: 'qr_login_invalid',
      status: 404,
    });
  });

  test('410 qr_confirm_window_expired（确认窗口关闭）错误码原样透传', async () => {
    const { client } = makeClient(() => {
      throw new ApiError({ status: 410, errorCode: 'qr_confirm_window_expired' });
    });
    const api = createQrLoginApi(client);
    expect(api.scan({ qrId: VIEW.qrId, secret: SECRET })).rejects.toMatchObject({
      name: 'ApiError',
      errorCode: 'qr_confirm_window_expired',
      status: 410,
    });
  });
});
