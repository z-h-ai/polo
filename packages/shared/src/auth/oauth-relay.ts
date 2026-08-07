import type { PreparedOAuthFlow } from './oauth-flow-types.ts';

export const OAUTH_RELAY_CALLBACK_URL = 'https://app.polo.z-h-ai.com/auth/callback';
export const OAUTH_RELAY_STATE_URL = 'https://app.polo.z-h-ai.com/auth/state';

export function isOAuthRelayState(value: string): boolean {
  return /^ca2\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{24,128}$/.test(value);
}

async function createOAuthRelayState(returnTo: string, innerState: string): Promise<string> {
  const response = await fetch(OAUTH_RELAY_STATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo, innerState }),
  });
  if (!response.ok) throw new Error(`OAuth relay state request failed with status ${response.status}`);
  const result = await response.json() as { state?: unknown };
  if (typeof result.state !== 'string' || !isOAuthRelayState(result.state)) {
    throw new Error('OAuth relay returned an invalid state');
  }
  return result.state;
}

export async function wrapPreparedOAuthFlowForRelay(
  prepared: PreparedOAuthFlow,
  returnTo: string,
): Promise<PreparedOAuthFlow> {
  const authUrl = new URL(prepared.authUrl);
  authUrl.searchParams.set('redirect_uri', OAUTH_RELAY_CALLBACK_URL);
  authUrl.searchParams.set('state', await createOAuthRelayState(returnTo, prepared.state));

  return {
    ...prepared,
    authUrl: authUrl.toString(),
    redirectUri: OAUTH_RELAY_CALLBACK_URL,
  };
}
