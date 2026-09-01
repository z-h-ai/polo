/**
 * Session MCP callback router.
 *
 * The session MCP server subprocess POSTs its `question_requested` callback
 * to `POST /request-user-input` on the host's callback port and AWAITS the
 * response — the tool result settles only when the durable handoff reached
 * its terminal state (persisted + broadcast + handoff, or an explicit
 * rejection). This router is the host-side consumer of that contract:
 * it routes the payload into the SessionManager's durable handoff
 * (`handleSessionMcpQuestionRequested`) and answers with the protocol result.
 */

import type { ISessionManager } from '@polo-ai/server-core/handlers';

export interface SessionMcpCallbackRequest {
  sessionId: string;
  questions: Array<Record<string, unknown>>;
  generationAtRequest: number;
}

export type SessionMcpCallbackResponse =
  | { status: 'accepted' }
  | { status: 'session_missing' }
  | { error: string };

/**
 * Handle one `POST /request-user-input` callback from the session MCP
 * server: perform the SessionManager durable handoff and answer with the
 * protocol result. Never throws — failures become `{ error }` responses so
 * the remote tool result degrades to an honest tool error.
 */
export async function handleSessionMcpRequestUserInputCallback(
  sessionManager: ISessionManager,
  body: unknown,
): Promise<SessionMcpCallbackResponse> {
  const payload = body as Partial<SessionMcpCallbackRequest> | null;
  if (
    !payload ||
    typeof payload.sessionId !== 'string' ||
    !Array.isArray(payload.questions) ||
    typeof payload.generationAtRequest !== 'number'
  ) {
    return { error: 'Malformed request-user-input callback payload' };
  }
  try {
    await sessionManager.handleSessionMcpQuestionRequested(
      payload.sessionId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload.questions as any,
      payload.generationAtRequest,
    );
    return { status: 'accepted' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/session_missing/.test(message)) {
      return { status: 'session_missing' };
    }
    return { error: message };
  }
}

/**
 * Minimal request handler for the host callback HTTP server: routes
 * `POST /request-user-input` callbacks of the session MCP server into the
 * SessionManager durable handoff. All other paths are answered 404.
 *
 * MEDIA-TYPE GATE: the endpoint is a STATE-CHANGING loopback route, so a
 * request body is only parsed when the sender declares an exact
 * `application/json` media type (optional parameters such as `charset` are
 * accepted; sub-type suffixes like `+json` and text/plain are NOT). Anything
 * else is rejected with 415 BEFORE the body is read — a simple cross-origin
 * `text/plain` POST needs no CORS preflight and must never reach the
 * SessionManager.
 */
export function createSessionMcpCallbackHandler(sessionManager: ISessionManager) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (request: any): Promise<Response> => {
    // METHOD GATE: only the declared POST is
    // allowed on the callback endpoint — any other method is rejected with
    // 405 + Allow BEFORE touching the SessionManager.
    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'POST' },
      });
    }
    const url = typeof request.url === 'string' ? request.url : '';
    if (new URL(url, 'http://localhost').pathname !== '/request-user-input') {
      return new Response('Not found', { status: 404 });
    }
    const contentType = typeof request.headers?.get === 'function'
      ? (request.headers.get('content-type') ?? '')
      : '';
    if (!/^application\/json\s*(?:;.*)?$/i.test(contentType.trim())) {
      return new Response(JSON.stringify({ error: 'Unsupported Media Type: expected application/json' }), {
        status: 415,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const result = await handleSessionMcpRequestUserInputCallback(sessionManager, body);
    return new Response(JSON.stringify(result), {
      status: 'error' in result ? 400 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
