// POL-244 unit tests for the 我的 tab presentation helpers (bun test).

import { describe, expect, test } from 'bun:test';

import { avatarInitials, maskPhone } from '../profileUi';

describe('maskPhone', () => {
  test('masks an 11-digit mainland mobile number like P13', () => {
    expect(maskPhone('13800008000')).toBe('138****8000');
  });

  test('passes through already-formatted or odd-length input', () => {
    expect(maskPhone('138 0000 8000')).toBe('138****8000');
    expect(maskPhone('12345')).toBe('12345');
    expect(maskPhone('')).toBe('');
  });
});

describe('avatarInitials', () => {
  test('prefers displayName, then username, then phone digits', () => {
    expect(avatarInitials({ phone: '13800008000', displayName: '欧阳' })).toBe('欧阳');
    expect(avatarInitials({ phone: '13800008000', username: 'douglas' })).toBe('DO');
    expect(avatarInitials({ phone: '13800008000' })).toBe('00');
    expect(avatarInitials({ phone: '1', displayName: null, username: undefined })).toBe('Po');
  });
});
