import { describe, expect, it } from 'bun:test';
import { VALID_CREDENTIAL_TYPES, credentialIdToAccount } from '../types.ts';

describe('admin_token credentials', () => {
  it('is a valid credential type', () => {
    expect(VALID_CREDENTIAL_TYPES).toContain('admin_token');
  });

  it('uses the global credential account', () => {
    expect(credentialIdToAccount({ type: 'admin_token' })).toBe('admin_token::global');
  });
});
