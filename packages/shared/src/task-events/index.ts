/**
 * Task Events — Public API
 *
 * Pub/Sub contract for chained task orchestration (POO-126):
 * - types.ts: event + subscription schema (Layer 0)
 * - task-subscription-manager.ts: matching, persistence, wake-up (Layer 1)
 * - task-subscription-store.ts: {workspace}/task-events/subscriptions.json
 * - task-chain-schema.ts + task-chain-loader.ts: declarative chains (Layer 3)
 */

export type {
  TaskEvent,
  TaskEventType,
  TaskSubscription,
  TaskSubscriptionMode,
  TaskSubscriptionSpec,
} from './types.ts';
export {
  TASK_EVENT_TYPES,
  renderTaskEventMessage,
  taskEventSchema,
  taskEventTypeSchema,
  taskSubscriptionSpecSchema,
} from './types.ts';

export { TaskSubscriptionManager, matchesSubscription, DEFAULT_CLOSED_STATUS_IDS } from './task-subscription-manager.ts';
export type { TaskSubscriptionManagerOptions, DeliverResult } from './task-subscription-manager.ts';
export {
  loadSubscriptions,
  saveSubscriptions,
  subscriptionsFilePath,
  taskEventsDir,
} from './task-subscription-store.ts';

export type {
  TaskChainFile,
  TaskChainStep,
  ResolvedTaskChain,
  ResolvedTaskChainStep,
} from './task-chain-schema.ts';
export {
  taskChainFileSchema,
  parseTaskChain,
  validateTaskChain,
} from './task-chain-schema.ts';
export {
  loadTaskChains,
  translateTaskChainToSubscriptions,
} from './task-chain-loader.ts';
