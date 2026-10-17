// Pure presentation helpers for the 我的 tab (POL-19, P13 account card).

import type { StoredUser } from '../auth/tokenStore';

/** '13800008000' -> '138****8000' (P13 account card mask). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 11) return phone;
  return `${digits.slice(0, 3)}****${digits.slice(7)}`;
}

/**
 * Avatar initials for the account card (P13 shows the two-letter monogram).
 * Prefers displayName/username; falls back to the last two phone digits since
 * the app only knows the phone number.
 */
export function avatarInitials(user: Pick<StoredUser, 'phone' | 'username' | 'displayName'>): string {
  const name = user.displayName?.trim() || user.username?.trim();
  if (name) return name.slice(0, 2).toUpperCase();
  const digits = user.phone.replace(/\D/g, '');
  if (digits.length >= 2) return digits.slice(-2);
  return 'Po';
}
