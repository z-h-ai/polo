// POL-16 unit tests for the pairing QR payload parser.
//
// The accepted surface mirrors the D02 convention (POL-13 Mac pairing panel):
// JSON {"code":"246810","wsUrl":"ws://..."} plus the bare 6-digit code.
// Failure modes are exhaustive: login-QR payloads (POL-15) must NOT be
// consumable as pairing codes and vice versa.

import { describe, expect, test } from 'bun:test';

import { parsePairingPayload, sanitizePairingCodeInput } from '../pairingPayload';

describe('parsePairingPayload — valid variants', () => {
  test('D02 JSON with code + wsUrl', () => {
    const raw = '{"code":"246810","wsUrl":"ws://192.168.31.42:8787"}';
    expect(parsePairingPayload(raw)).toEqual({
      kind: 'valid',
      code: '246810',
      wsUrl: 'ws://192.168.31.42:8787',
    });
  });

  test('JSON with code only (wsUrl optional)', () => {
    expect(parsePairingPayload('{"code":"000000"}')).toEqual({
      kind: 'valid',
      code: '000000',
      wsUrl: null,
    });
  });

  test('whitespace around the JSON and inside the code is tolerated', () => {
    expect(parsePairingPayload('  {"code": " 246810 ", "extra": 1}  ')).toEqual({
      kind: 'valid',
      code: '246810',
      wsUrl: null,
    });
  });

  test('empty-string wsUrl falls back to null', () => {
    expect(parsePairingPayload('{"code":"246810","wsUrl":"   "}')).toEqual({
      kind: 'valid',
      code: '246810',
      wsUrl: null,
    });
  });

  test('bare 6-digit code (QR printed without JSON)', () => {
    expect(parsePairingPayload('246810')).toEqual({ kind: 'valid', code: '246810', wsUrl: null });
  });

  test('extra fields (macDeviceId, version) are ignored', () => {
    expect(parsePairingPayload('{"code":"246810","wsUrl":"w://l","macDeviceId":"m1","v":2}')).toEqual({
      kind: 'valid',
      code: '246810',
      wsUrl: 'w://l',
    });
  });
});

describe('parsePairingPayload — invalid variants', () => {
  test('qr-LOGIN payload is not a pairing code (POL-15 互斥)', () => {
    const raw = 'https://www.z-h-ai.com/qr-login?qrId=abc&secret=def';
    expect(parsePairingPayload(raw)).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
  });

  test('garbage / empty / non-JSON', () => {
    expect(parsePairingPayload('')).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
    expect(parsePairingPayload('hello')).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
    expect(parsePairingPayload('{"code":"246810"')).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
    expect(parsePairingPayload('[1,2]')).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
    expect(parsePairingPayload('null')).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
  });

  test('JSON without a code field -> missing_code', () => {
    expect(parsePairingPayload('{"wsUrl":"ws://lan"}')).toEqual({
      kind: 'invalid',
      reason: 'missing_code',
    });
    expect(parsePairingPayload('{"code":246810}')).toEqual({
      kind: 'invalid',
      reason: 'missing_code',
    });
  });

  test('JSON with a non-6-digit code -> bad_code', () => {
    expect(parsePairingPayload('{"code":"24681"}')).toEqual({ kind: 'invalid', reason: 'bad_code' });
    expect(parsePairingPayload('{"code":"2468100"}')).toEqual({ kind: 'invalid', reason: 'bad_code' });
    expect(parsePairingPayload('{"code":"8F3K2Q"}')).toEqual({ kind: 'invalid', reason: 'bad_code' });
    expect(parsePairingPayload('{"code":""}')).toEqual({ kind: 'invalid', reason: 'bad_code' });
  });
});

describe('sanitizePairingCodeInput', () => {
  test('keeps digits only and caps at 6', () => {
    expect(sanitizePairingCodeInput('24a6-810x9')).toBe('246810');
    expect(sanitizePairingCodeInput('1234567890')).toBe('123456');
    expect(sanitizePairingCodeInput('')).toBe('');
  });
});
