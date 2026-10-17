// API base configuration (POL-14).
//
// The admin base URL comes from the EXPO_PUBLIC_API_URL environment variable,
// which Expo inlines into the bundle at build time (app config extra is not
// needed). Development default targets the local admin server.

export const DEFAULT_API_BASE_URL = 'http://localhost:3000';

export function resolveApiBaseUrl(env?: string): string {
  const raw = (env ?? process.env.EXPO_PUBLIC_API_URL ?? '').trim();
  if (!raw) return DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, '');
}

export const apiBaseUrl = resolveApiBaseUrl();
