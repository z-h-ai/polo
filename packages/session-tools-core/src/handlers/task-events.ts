/**
 * Task pub/sub handlers (POO-126)
 *
 * subscribe_task / unsubscribe_task / list_task_subscriptions / emit_task_event.
 * Handlers are thin: they validate shape and delegate to the context
 * callbacks, which the SessionManager binds to the workspace's
 * TaskSubscriptionManager. All wake-up delivery happens server-side — an
 * agent registers a subscription once and ends its turn instead of polling
 * get_session_info in a loop.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SubscribeTaskArgs {
  targetSessionId: string;
  events?: Array<'status_changed' | 'completed' | 'failed' | 'custom'>;
  statuses?: string[];
  instruction?: string;
  mode?: 'once' | 'persistent';
  /** Subscription TTL in milliseconds from now (optional). */
  ttlMs?: number;
  help?: boolean;
}

export interface UnsubscribeTaskArgs {
  subscriptionId: string;
}

export interface ListTaskSubscriptionsArgs {
  /** 'mine' (default) — this session; 'all' — current trusted scope. */
  scope?: 'mine' | 'all';
}

export interface EmitTaskEventArgs {
  type: 'completed' | 'failed' | 'custom';
  detail?: string;
}

interface SubscriptionSummary {
  id: string;
  targetSessionId: string;
  events: string[];
  statuses?: string[];
  mode: string;
  instruction?: string;
  fireCount: number;
  source?: string;
}

export async function handleSubscribeTask(
  ctx: SessionToolContext,
  args: SubscribeTaskArgs
): Promise<ToolResult> {
  if (!ctx.subscribeTask) {
    return errorResponse('subscribe_task is not available in this context.');
  }

  if (args.help) {
    return successResponse(
      [
        'subscribe_task registers this session as a listener on another session\'s task events.',
        'When a matching event arrives, this session receives an injected message and starts a new turn.',
        '',
        'targetSessionId is a Polo session ID; instruction describes the authorized next action.',
        'After successful registration, end your turn. The runtime delivers the wake-up; do not poll.',
        'Read the task-chain-pubsub Skill for title lookup, disambiguation, receipts and cancellation.',
        '',
        'events: status_changed | completed | failed | custom (default: completed + failed).',
        'statuses: optional status-id narrow for status-derived events.',
        'mode: once (default — fires a single time) | persistent.',
      ].join('\n')
    );
  }

  if (!args.targetSessionId?.trim()) {
    return errorResponse('targetSessionId is required. Use list_sessions to find it, or spawn_session and use the returned sessionId.');
  }

  try {
    const result = await ctx.subscribeTask({
      targetSessionId: args.targetSessionId.trim(),
      events: args.events,
      statuses: args.statuses,
      instruction: args.instruction,
      mode: args.mode,
      expiresAtMs: args.ttlMs,
    });
    if (!result.ok) {
      return errorResponse(result.error);
    }
    return successResponse(result.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`subscribe_task failed: ${message}`);
  }
}

export async function handleUnsubscribeTask(
  ctx: SessionToolContext,
  args: UnsubscribeTaskArgs
): Promise<ToolResult> {
  if (!ctx.unsubscribeTask) {
    return errorResponse('unsubscribe_task is not available in this context.');
  }
  if (!args.subscriptionId?.trim()) {
    return errorResponse('subscriptionId is required (see list_task_subscriptions).');
  }

  try {
    const result = await ctx.unsubscribeTask(args.subscriptionId.trim());
    if (!result.ok) {
      return errorResponse(result.error ?? 'Failed to unsubscribe.');
    }
    return successResponse(`Subscription ${args.subscriptionId} removed.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`unsubscribe_task failed: ${message}`);
  }
}

export async function handleListTaskSubscriptions(
  ctx: SessionToolContext,
  args: ListTaskSubscriptionsArgs
): Promise<ToolResult> {
  if (!ctx.listTaskSubscriptions) {
    return errorResponse('list_task_subscriptions is not available in this context.');
  }

  try {
    const result = await ctx.listTaskSubscriptions(args.scope === 'all' ? 'all' : 'mine');
    if (!result.ok) {
      return errorResponse(result.error);
    }
    if (result.subscriptions.length === 0) {
      return successResponse('No task subscriptions. Use subscribe_task to listen to another session\'s completion.');
    }
    const lines = result.subscriptions.map((sub: SubscriptionSummary) => {
      const parts = [
        `${sub.id}`,
        `listens: ${sub.targetSessionId}`,
        `events: ${sub.events.join(',')}`,
        `mode: ${sub.mode}`,
      ];
      if (sub.statuses?.length) parts.push(`statuses: ${sub.statuses.join(',')}`);
      if (sub.instruction) parts.push(`instruction: ${sub.instruction}`);
      if (sub.source) parts.push(`source: ${sub.source}`);
      return `- ${parts.join(' | ')}`;
    });
    return successResponse(`${result.subscriptions.length} subscription(s):\n${lines.join('\n')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`list_task_subscriptions failed: ${message}`);
  }
}

export async function handleEmitTaskEvent(
  ctx: SessionToolContext,
  args: EmitTaskEventArgs
): Promise<ToolResult> {
  if (!ctx.emitTaskEvent) {
    return errorResponse('emit_task_event is not available in this context.');
  }
  if (!args.type) {
    return errorResponse('type is required: completed | failed | custom.');
  }

  try {
    // The callback is bound to THIS session — a session can only emit events
    // about itself, never forge another session's completion.
    const result = await ctx.emitTaskEvent({ type: args.type, detail: args.detail });
    if (!result.ok) {
      return errorResponse(result.error ?? 'Failed to emit task event.');
    }
    const listeners = result.subscriberCount ?? 0;
    return successResponse(
      listeners > 0
        ? `Event "${args.type}" emitted — ${listeners} subscriber session(s) woken up.`
        : `Event "${args.type}" emitted (no active subscribers for this session).`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`emit_task_event failed: ${message}`);
  }
}
