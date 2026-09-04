/**
 * Session-Scoped Tool Callback Registry
 *
 * Extracted from session-scoped-tools.ts to break the dependency between
 * the callback registry (shared by Claude + Pi paths) and the Claude SDK
 * adapter layer (only used by ClaudeAgent).
 *
 * The registry is a simple Map keyed by sessionId. Each backend registers
 * callbacks when a session starts and merges additional callbacks (e.g.
 * browser pane functions) as they become available.
 */

import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import type { SpawnSessionFn } from './spawn-session-tool.ts';
import type { BrowserPaneFns } from './browser-tools.ts';
import type { AuthRequest, RequestUserInputQuestionArgs } from '@polo-ai/session-tools-core';
import { debug } from '../utils/debug.ts';

/**
 * Callbacks that can be registered per-session
 */
import { randomUUID } from 'node:crypto';
export interface SessionScopedToolCallbacks {
  /**
   * Called when a plan is submitted via SubmitPlan tool.
   * Receives the path to the plan markdown file.
   */
  onPlanSubmitted?: (planPath: string) => void;

  /**
   * Called when authentication is requested via OAuth/credential tools.
   * The auth UI should be shown and execution paused.
   */
  onAuthRequest?: (request: AuthRequest) => void;

  /**
   * Called when the agent requests structured user input via
   * request_user_input. The question UI should be shown and the turn paused.
   * May return a Promise — the tool handler awaits the durable handoff.
   * `generationAtRequest` is the issuing turn's processing generation,
   * snapshotted by the agent at tool-call time and carried through.
   */
  onQuestionRequested?: (questions: RequestUserInputQuestionArgs[], generationAtRequest: number) => void | Promise<void>;

  /**
   * Reader for the CURRENT processing generation, registered by each agent
   * backend. It is invoked by the tool handler AT TOOL-CALL INITIATION —
   * synchronously, before any await — and the returned value is bound
   * immutably into the callback chain from there.
   */
  getTurnGeneration?: () => number;

  /**
   * Agent-native LLM query callback for call_llm tool (OAuth path).
   * Each agent backend sets this to its own queryLlm implementation.
   */
  queryFn?: (request: LLMQueryRequest) => Promise<LLMQueryResult>;

  /**
   * Callback for spawn_session tool — creates an independent session and sends initial prompt.
   * Each agent backend delegates to its onSpawnSession callback.
   */
  spawnSessionFn?: SpawnSessionFn;

  /**
   * Browser pane functions for browser_* tools.
   * Set by the Electron session manager — wraps BrowserPaneManager
   * with the session's bound browser instance.
   */
  browserPaneFns?: BrowserPaneFns;

  /** Set labels on a session (defaults to current). */
  setSessionLabelsFn?: (sessionId: string | undefined, labels: string[]) => void | Promise<void>;
  /** Set status on a session (defaults to current). */
  setSessionStatusFn?: (sessionId: string | undefined, status: string) => void | Promise<void>;
  /** Get detailed info about a session (defaults to current). */
  getSessionInfoFn?: (sessionId?: string) => import('@polo-ai/session-tools-core').SessionInfo | null;
  /** List sessions in the workspace with pagination. */
  listSessionsFn?: (options?: import('@polo-ai/session-tools-core').ListSessionsOptions) => import('@polo-ai/session-tools-core').ListSessionsResult;
  /** Resolve label display names to IDs. */
  resolveLabelsFn?: (labels: string[]) => import('@polo-ai/session-tools-core').ResolvedLabelsResult;
  /** Resolve a status display name to its ID. */
  resolveStatusFn?: (status: string) => import('@polo-ai/session-tools-core').ResolvedStatusResult;
  /** Send a message to another session (inter-session messaging). */
  sendAgentMessageFn?: (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => Promise<void>;
  /**
   * Activate a source in the running session (source_test auto-enable flow).
   * Wired by SessionManager to the per-session onSourceActivationRequest callback
   * plus a backend-aware readiness signal (Pi vs Claude).
   */
  activateSourceInSessionFn?: (sourceSlug: string) => Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'immediate' | 'next-turn';
  }>;
  /** Get messaging bindings for a session. */
  getMessagingBindingsFn?: (sessionId: string) => Array<{ platform: string; channelId: string; threadId?: number; channelName?: string; enabled: boolean }>;
  /** Unbind messaging channels from a session. Returns count of removed bindings. */
  unbindMessagingChannelFn?: (sessionId: string, platform?: string) => number;
}

// Registry of callbacks keyed by sessionId
const sessionScopedToolCallbackRegistry = new Map<string, SessionScopedToolCallbacks>();

/**
 * R39-2: the authoritative per-session registration guard. SessionManager
 * installs this BEFORE Agent construction; every callback registered or
 * merged afterwards (backend core/plan/auth/query records, messaging,
 * browser panes, self-management, and any future record) is wrapped so the
 * guard runs at invocation, before the callback reads, mutates, dispatches
 * or publishes. The guard resolves the caller's CURRENT stable
 * transition/account/fence scope and throws on missing/stale scope —
 * deny-by-default.
 */
export type SessionScopedToolCallbackGuard = (callbackName: string) => void;

const sessionScopedToolCallbackGuards = new Map<string, SessionScopedToolCallbackGuard>();

/**
 * R49/R51: the per-session OWNER LEASE — the installed (guard-wrapped)
 * record AND the guard snapshot taken at that registration, as ONE atomic
 * ownership pair, bound to an immutable RUNTIME OWNER TOKEN. Every
 * register/merge REPLACES the session's lease and returns it; owner-bound
 * cleanup CASses against the lease it captured. The guard is independently
 * replaceable state (a successor may install a newer guard before lazily
 * registering callbacks), so ALL THREE identities must match for a removal
 * to be authorized. A stale owner's merge against a successor's lease is
 * REJECTED outright.
 */
export type SessionScopedToolCallbackLease = import('./session-scoped-callback-lease.ts').SessionScopedToolCallbackLease & {
  record: SessionScopedToolCallbacks;
  guard: SessionScopedToolCallbackGuard | undefined;
};

const sessionScopedToolCallbackLeases = new Map<string, SessionScopedToolCallbackLease>();

export function installSessionScopedToolCallbackGuard(
  sessionId: string,
  guard: SessionScopedToolCallbackGuard,
): void {
  sessionScopedToolCallbackGuards.set(sessionId, guard);
  debug('session-scoped-tools', `Installed callback guard for session ${sessionId}`);
}

function applySessionScopedToolCallbackGuard(
  sessionId: string,
  callbacks: Partial<SessionScopedToolCallbacks>,
): Partial<SessionScopedToolCallbacks> {
  const guard = sessionScopedToolCallbackGuards.get(sessionId);
  if (!guard) return callbacks;
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(callbacks)) {
    wrapped[key] = typeof value === 'function'
      ? (...args: unknown[]) => {
          guard(`${sessionId}.${key}`);
          return (value as (...invokeArgs: unknown[]) => unknown)(...args);
        }
      : value;
  }
  return wrapped as Partial<SessionScopedToolCallbacks>;
}

/**
 * Register callbacks for a specific session. Every function-valued entry is
 * atomically wrapped with the installed per-session guard (R39-2).
 *
 * R48: returns the INSTALLED (guard-wrapped) record — the lease handle that
 * `unregisterSessionScopedToolCallbacksIf` compares against, so an owner can
 * clean up its own registration without ever touching a successor's.
 */
export function registerSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: SessionScopedToolCallbacks,
  ownerToken?: string,
): SessionScopedToolCallbackLease {
  const installed = applySessionScopedToolCallbackGuard(sessionId, callbacks);
  // R52: construction is exclusive (lifecycle lock) — a fresh registration
  // takes ownership with the caller's immutable runtime owner token.
  const lease: SessionScopedToolCallbackLease = {
    record: installed,
    guard: sessionScopedToolCallbackGuards.get(sessionId),
    ownerToken: ownerToken ?? randomUUID(),
  };
  sessionScopedToolCallbackRegistry.set(sessionId, installed);  sessionScopedToolCallbackLeases.set(sessionId, lease);
  debug('session-scoped-tools', `Registered callbacks for session ${sessionId} (owner ${lease.ownerToken})`);
  return lease;
}

/**
 * Merge additional callbacks into an existing session's callback set.
 * Used by the Electron session manager to add browser pane functions
 * after the agent has already registered its core callbacks. Merged
 * entries are guard-wrapped exactly like registered entries (R39-2).
 */
export function mergeSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: Partial<SessionScopedToolCallbacks>,
  ownerToken?: string,
): SessionScopedToolCallbackLease {
  const current = sessionScopedToolCallbackLeases.get(sessionId);
  // R52: OWNER-VERIFIED merge — a stale runtime arriving after a same-id
  // successor published its own lease must NEVER merge its callbacks into
  // the successor's record (under the successor's guard). Reject outright.
  if (ownerToken !== undefined && current !== undefined && current.ownerToken !== ownerToken) {
    throw new Error(`SESSION_CALLBACK_LEASE_OWNER_MISMATCH (session ${sessionId}: live lease owner ${current.ownerToken} != caller owner ${ownerToken})`);
  }
  const existing = sessionScopedToolCallbackRegistry.get(sessionId) ?? {};
  const merged = {
    ...existing,
    ...applySessionScopedToolCallbackGuard(sessionId, callbacks),
  };
  sessionScopedToolCallbackRegistry.set(sessionId, merged);
  // R49/R51: the merged record supersedes the previous one — the session's
  // lease is REPLACED and returned so the owner can re-bind it (per-turn
  // merges by a live backend keep the owner's lease current).
  const lease: SessionScopedToolCallbackLease = {
    record: merged,
    guard: sessionScopedToolCallbackGuards.get(sessionId),
    // R52-B: a token-less merge (trusted SM-internal record updates such as
    // browser panes) PRESERVES the current owner — only an owner-verified
    // merge may re-bind ownership.
    ownerToken: ownerToken ?? current?.ownerToken ?? randomUUID(),
  };
  sessionScopedToolCallbackLeases.set(sessionId, lease);
  debug('session-scoped-tools', `Merged callbacks for session ${sessionId} (owner ${lease.ownerToken})`);
  return lease;
}

/**
 * Unregister callbacks for a session. Also clears the per-session
 * registration guard (cleanup on destroy/construction failure, R39-2).
 */
export function unregisterSessionScopedToolCallbacks(sessionId: string): void {
  sessionScopedToolCallbackLeases.delete(sessionId);
  sessionScopedToolCallbackRegistry.delete(sessionId);
  sessionScopedToolCallbackGuards.delete(sessionId);
  debug('session-scoped-tools', `Unregistered callbacks for session ${sessionId}`);
}

/**
 * R49/R51: atomic compare-and-unregister against a full OWNER LEASE — the
 * session's CURRENT (record, guard) pair must BOTH still be the expected
 * owner's. The guard is independently replaceable state: a successor owner
 * that has installed a newer guard (before lazily registering its own
 * callbacks) must never be erased by a stale owner's cleanup — in that case
 * the CAS fails and the caller skips its callback/guard face. A
 * GUARD-ONLY lease (record undefined) removes just the guard when nothing
 * was ever registered under it. Returns whether the removal happened.
 */
export function unregisterSessionScopedToolCallbacksIf(
  sessionId: string,
  expected: SessionScopedToolCallbackLease,
): boolean {
  // Compare the LIVE registry state (record + guard + owner token) against
  // the lease's INSTALL-TIME snapshot — never the lease object against
  // itself. Any drift (successor record, newer guard, different owner)
  // fails the CAS and the caller skips its callback/guard face.
  const liveRecord = sessionScopedToolCallbackRegistry.get(sessionId);
  const liveGuard = sessionScopedToolCallbackGuards.get(sessionId);
  const liveLease = sessionScopedToolCallbackLeases.get(sessionId);
  const recordMatches = expected.record !== undefined
    ? liveRecord === expected.record
    : liveRecord === undefined;
  const guardMatches = expected.guard !== undefined
    ? liveGuard === expected.guard
    : liveGuard === undefined;
  const ownerMatches = liveLease !== undefined
    ? liveLease.ownerToken === expected.ownerToken
    : false;
  if (!recordMatches || !guardMatches || !ownerMatches) {
    return false;
  }
  sessionScopedToolCallbackLeases.delete(sessionId);
  unregisterSessionScopedToolCallbacks(sessionId)
  return true
}

/**
 * R51: the session's CURRENT owner lease (record + guard pair), or undefined
 * when nothing is registered. Owner-bound disposal paths capture this at
 * entry and CAS against it after their awaits.
 */
export function getSessionScopedToolCallbackLease(
  sessionId: string,
): SessionScopedToolCallbackLease | undefined {
  return sessionScopedToolCallbackLeases.get(sessionId);
}

/**
 * R49: the explicitly named UNCONDITIONAL whole-session teardown. Only for
 * full-session close paths that own every registration for the id — never on
 * default disposal paths (those use the lease CAS above).
 */
export function unregisterAllSessionScopedToolCallbacks(sessionId: string): void {
  unregisterSessionScopedToolCallbacks(sessionId)
}

/**
 * Get callbacks for a session
 */
export function getSessionScopedToolCallbacks(sessionId: string): SessionScopedToolCallbacks | undefined {
  return sessionScopedToolCallbackRegistry.get(sessionId);
}

/**
 * R52-A: GUARD-ONLY compare-and-unregister. Removes the per-session guard
 * ONLY while (a) the live guard is still exactly `expectedGuard` and (b) NO
 * callback record was ever registered (a present record means a successor
 * owner took the id — its registration must stay guarded, never unguarded by
 * a stale construction's cleanup). Returns whether the removal happened.
 */
export function unregisterSessionScopedToolGuardIf(
  sessionId: string,
  expectedGuard: SessionScopedToolCallbackGuard,
): boolean {
  if (sessionScopedToolCallbackRegistry.get(sessionId) !== undefined) {
    return false;
  }
  if (sessionScopedToolCallbackGuards.get(sessionId) !== expectedGuard) {
    return false;
  }
  sessionScopedToolCallbackGuards.delete(sessionId);
  debug('session-scoped-tools', `Removed guard-only lease for session ${sessionId}`);
  return true;
}

/**
 * R51: the session's installed GUARD (for guard-only lease cleanup).
 */
export function getSessionScopedToolCallbackGuard(
  sessionId: string,
): SessionScopedToolCallbackGuard | undefined {
  return sessionScopedToolCallbackGuards.get(sessionId);
}
