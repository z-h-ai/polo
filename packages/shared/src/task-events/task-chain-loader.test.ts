/**
 * Tests for the declarative task chain schema + loader
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseTaskChain, validateTaskChain } from './task-chain-schema.ts';
import { loadTaskChains, translateTaskChainToSubscriptions } from './task-chain-loader.ts';
import type { TaskChainFile } from './task-chain-schema.ts';

const VALID_YAML = `
chain: review-after-implement
description: 实现完成后自动进入审查
steps:
  - id: implement
    session: implement-feature-x
  - id: review
    after: implement
    session: review-session
    prompt: 审查 implement 会话的产出。
`;

describe('parseTaskChain', () => {
  it('parses a valid YAML chain', () => {
    const { chain, errors } = parseTaskChain(VALID_YAML, 'review.yaml');
    expect(errors).toEqual([]);
    expect(chain).not.toBeUndefined();
    expect(chain!.chain).toBe('review-after-implement');
    expect(chain!.steps).toHaveLength(2);
    expect(chain!.steps[1]!.after).toBe('implement');
  });

  it('parses an equivalent JSON chain', () => {
    const json = JSON.stringify({
      chain: 'j',
      steps: [{ id: 'a', session: 's-a' }, { id: 'b', after: 'a', session: 's-b' }],
    });
    const { chain, errors } = parseTaskChain(json, 'chain.json');
    expect(errors).toEqual([]);
    expect(chain!.steps[1]!.after).toBe('a');
  });

  it('reports invalid YAML without throwing', () => {
    const { chain, errors } = parseTaskChain('chain: [unclosed', 'broken.yaml');
    expect(chain).toBeUndefined();
    expect(errors[0]).toContain('invalid YAML');
  });

  it('reports schema violations with the offending path', () => {
    const { errors } = parseTaskChain('steps: []', 'empty.yaml');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('chain');
  });

  it('rejects malformed step ids and multi-dependency joins', () => {
    const badId = parseTaskChain('chain: c\nsteps:\n  - id: "1 bad"\n    session: s', 'x.yaml');
    expect(badId.errors.join(' ')).toContain('step id');

    const multi = parseTaskChain(
      'chain: c\nsteps:\n  - id: a\n    session: s\n  - id: b\n    after: [a, a2]\n    session: s',
      'x.yaml',
    );
    expect(multi.errors.join(' ')).toContain('Too big');
  });
});

describe('validateTaskChain', () => {
  const chain: TaskChainFile = {
    chain: 'c',
    steps: [
      { id: 'a', session: 's-a' },
      { id: 'b', after: 'a', session: 's-b' },
    ],
  };

  it('accepts a valid chain', () => {
    expect(validateTaskChain(chain)).toEqual([]);
  });

  it('rejects unknown dependencies', () => {
    const errors = validateTaskChain({
      chain: 'c',
      steps: [{ id: 'a', session: 's' }, { id: 'b', after: 'nope', session: 's' }],
    });
    expect(errors.join(' ')).toContain('unknown step');
  });

  it('rejects dependency cycles', () => {
    const errors = validateTaskChain({
      chain: 'c',
      steps: [
        { id: 'a', after: 'b', session: 's' },
        { id: 'b', after: 'a', session: 's' },
      ],
    });
    expect(errors.join(' ')).toContain('cycle');
  });
});

describe('loadTaskChains', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'polo-task-chains-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function writeChain(name: string, content: string): void {
    mkdirSync(join(workspaceRoot, 'task-events', 'chains'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'task-events', 'chains', name), content);
  }

  const resolveSession = (nameOrId: string) =>
    ({ 'implement-feature-x': { id: 'sess-1', name: 'implement-feature-x' } } as Record<string, { id: string; name?: string }>)[nameOrId]
      ?? ({ 'review-session': { id: 'sess-2', name: 'review-session' } } as Record<string, { id: string; name?: string }>)[nameOrId]
      ?? null;

  it('returns nothing when the chains dir is absent', () => {
    expect(loadTaskChains(workspaceRoot, { resolveSession })).toEqual({ chains: [], errors: [] });
  });

  it('loads a valid chain with sessions resolved to ids', () => {
    writeChain('review.yaml', VALID_YAML);
    const { chains, errors } = loadTaskChains(workspaceRoot, { resolveSession });
    expect(errors).toEqual([]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.steps.map((s) => s.sessionId)).toEqual(['sess-1', 'sess-2']);
    expect(chains[0]!.steps[1]!.afterStepId).toBe('implement');
  });

  it('fails soft on a broken file and still loads the rest', () => {
    writeChain('broken.yaml', 'chain: [');
    writeChain('good.yaml', VALID_YAML);
    const { chains, errors } = loadTaskChains(workspaceRoot, { resolveSession });
    expect(chains).toHaveLength(1);
    expect(chains[0]!.sourceFile).toBe('good.yaml');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('broken.yaml');
  });

  it('rejects chains whose sessions do not exist, without partial application', () => {
    writeChain('review.yaml', VALID_YAML.replace('review-session', 'missing-session'));
    const { chains, errors } = loadTaskChains(workspaceRoot, { resolveSession });
    expect(chains).toHaveLength(0);
    expect(errors[0]).toContain('missing-session');
  });
});

describe('translateTaskChainToSubscriptions', () => {
  it('creates one once-subscription per dependency edge', () => {
    const chain = {
      chainName: 'review-after-implement',
      sourceFile: 'review.yaml',
      steps: [
        { id: 'implement', session: 'implement-feature-x', sessionId: 'sess-1' },
        { id: 'review', session: 'review-session', sessionId: 'sess-2', afterStepId: 'implement', prompt: '审查产出' },
      ],
    };
    const specs = translateTaskChainToSubscriptions(chain);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toEqual({
      targetSessionId: 'sess-1',
      subscriberSessionId: 'sess-2',
      events: ['completed', 'failed'],
      instruction: '审查产出',
      mode: 'once',
      source: 'chain:review.yaml#review',
    });
  });

  it('falls back to a default instruction when the step has no prompt', () => {
    const chain = {
      chainName: 'my-chain',
      sourceFile: 'c.yaml',
      steps: [
        { id: 'a', session: 's-a', sessionId: '1' },
        { id: 'b', session: 's-b', sessionId: '2', afterStepId: 'a' },
      ],
    };
    const specs = translateTaskChainToSubscriptions(chain);
    expect(specs[0]!.instruction).toContain('my-chain');
    expect(specs[0]!.instruction).toContain('a');
  });
});
