/**
 * Task chain loader — turns declarative chain files into subscriptions
 *
 * Reads {workspaceRootPath}/task-events/chains/*.{yaml,yml,json}, validates
 * each file, resolves session references (name or id) against the workspace,
 * and translates every dependency edge into ONE 'once' subscription:
 * the upstream step's session completing wakes the downstream step's session.
 *
 * Loading is fail-soft per file: a broken chain file reports an error and the
 * remaining chains still load. Session resolution must succeed for every
 * step of a chain before any of its subscriptions are created — a chain that
 * references a not-yet-created session is reported, never half-applied.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/debug.ts';
import { parseTaskChain, validateTaskChain, type ResolvedTaskChain, type ResolvedTaskChainStep, type TaskChainFile } from './task-chain-schema.ts';
import type { TaskSubscriptionSpec } from './types.ts';

const log = createLogger('task-chains');

const CHAINS_DIR = 'task-events/chains';
const CHAIN_EXTENSIONS = ['.yaml', '.yml', '.json'];

export function taskChainsDir(workspaceRootPath: string): string {
  return join(workspaceRootPath, CHAINS_DIR);
}

export interface SessionRef {
  id: string;
  name?: string;
}

export interface LoadTaskChainsOptions {
  /** Resolve a session by id or display name; null when not found. */
  resolveSession: (nameOrId: string) => SessionRef | null;
}

export interface LoadTaskChainsResult {
  chains: ResolvedTaskChain[];
  errors: string[];
}

/** Load + validate + resolve every chain file in the workspace. */
export function loadTaskChains(workspaceRootPath: string, opts: LoadTaskChainsOptions): LoadTaskChainsResult {
  const dir = taskChainsDir(workspaceRootPath);
  if (!existsSync(dir)) return { chains: [], errors: [] };

  const files = readdirSync(dir)
    .filter((f) => CHAIN_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)))
    .sort();
  const chains: ResolvedTaskChain[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const path = join(dir, file);
    try {
      const raw = readFileSync(path, 'utf-8');
      const { chain, errors: parseErrors } = parseTaskChain(raw, file);
      if (!chain) {
        errors.push(...parseErrors);
        continue;
      }
      const structural = validateTaskChain(chain);
      if (structural.length) {
        errors.push(...structural.map((e) => `${file}: ${e}`));
        continue;
      }
      const resolved = resolveChainSessions(chain, file, opts.resolveSession);
      if (typeof resolved === 'string') {
        errors.push(`${file}: ${resolved}`);
        continue;
      }
      chains.push(resolved);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${file}: ${msg}`);
    }
  }
  return { chains, errors };
}

function resolveChainSessions(
  chain: TaskChainFile,
  file: string,
  resolveSession: LoadTaskChainsOptions['resolveSession'],
): ResolvedTaskChain | string {
  const steps: ResolvedTaskChainStep[] = [];
  for (const step of chain.steps) {
    const ref = resolveSession(step.session);
    if (!ref) {
      return `step "${step.id}" references session "${step.session}" which does not exist in this workspace`;
    }
    const after = step.after === undefined ? undefined : Array.isArray(step.after) ? step.after[0] : step.after;
    steps.push({ ...step, sessionId: ref.id, afterStepId: after });
  }
  const sessionSteps = new Map<string, string>();
  for (const step of steps) {
    const previous = sessionSteps.get(step.sessionId);
    if (previous) {
      return `steps "${previous}" and "${step.id}" reuse the same session (including aliases); each step needs a distinct session`;
    }
    sessionSteps.set(step.sessionId, step.id);
  }
  log.debug(`[${file}] chain "${chain.chain}" resolved (${steps.length} steps)`);
  return {
    chainName: chain.chain,
    description: chain.description,
    sourceFile: file,
    steps,
  };
}

/**
 * Translate a resolved chain into subscription specs. Entry steps (no
 * `after`) produce nothing — they are started by a human or an upstream
 * system. Every dependency edge produces one 'once' subscription observing
 * the upstream session's completion.
 */
export function translateTaskChainToSubscriptions(chain: ResolvedTaskChain): TaskSubscriptionSpec[] {
  const byId = new Map(chain.steps.map((s) => [s.id, s]));
  const specs: TaskSubscriptionSpec[] = [];

  for (const step of chain.steps) {
    if (!step.afterStepId) continue;
    const upstream = byId.get(step.afterStepId);
    if (!upstream) continue; // validateTaskChain already rejects this.
    specs.push({
      targetSessionId: upstream.sessionId,
      subscriberSessionId: step.sessionId,
      events: ['completed', 'failed'],
      instruction: step.prompt
        ?? `Task chain "${chain.chainName}": upstream step "${upstream.id}" finished. Continue with this step ("${step.id}") now.`,
      mode: 'once',
      source: `chain:${chain.sourceFile}#${step.id}`,
    });
  }
  return specs;
}
