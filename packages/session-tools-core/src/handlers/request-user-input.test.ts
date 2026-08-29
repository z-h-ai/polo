/**
 * request_user_input tool tests
 *
 * Covers the canonical Zod schema constraints (counts, uniqueness, lengths,
 * reserved "Other" id, exclusive-on-multiple-only) and the registry handler
 * contract (callback invocation + waiting result).
 */

import { describe, expect, it } from 'bun:test';
import {
  RequestUserInputArgsSchema,
  validateRequestUserInputArgs,
  parseRequestUserInputArgs,
  REQUEST_USER_INPUT_OTHER_OPTION_ID,
  SESSION_TOOL_DEFS,
  SESSION_TOOL_REGISTRY,
  getSessionToolDefs,
  getToolDefsAsJsonSchema,
  handleRequestUserInput,
} from '../index.ts';
import type { SessionToolContext } from '../index.ts';
import type { RequestUserInputQuestionArgs } from '../question-types.ts';

function makeQuestion(overrides: Partial<RequestUserInputQuestionArgs> = {}): RequestUserInputQuestionArgs {
  return {
    id: 'data-handling',
    header: 'Data',
    question: 'How should related data be handled?',
    options: [
      { id: 'trash', label: 'Move to Trash', description: 'Recommended — recoverable for 30 days', recommended: true },
      { id: 'delete', label: 'Delete Permanently', description: 'Immediately erased and unrecoverable' },
    ],
    ...overrides,
  };
}

function makeCtx(callbacks: Partial<SessionToolContext['callbacks']> = {}): SessionToolContext {
  return {
    sessionId: 'test-session',
    workspacePath: '/tmp/test-workspace',
    get sourcesPath() { return '/tmp/test-workspace/sources'; },
    get skillsPath() { return '/tmp/test-workspace/skills'; },
    plansFolderPath: '/tmp/test-workspace/plans',
    fs: {
      exists: () => false,
      readFile: () => '',
      readFileBuffer: () => Buffer.alloc(0),
      writeFile: () => {},
      isDirectory: () => false,
      readdir: () => [],
      stat: () => ({ size: 0, isDirectory: () => false }),
    },
    loadSourceConfig: () => null,
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
      ...callbacks,
    },
  } as SessionToolContext;
}

describe('RequestUserInputArgsSchema', () => {
  it('accepts a single question with two options', () => {
    const result = RequestUserInputArgsSchema.safeParse({ questions: [makeQuestion()] });
    expect(result.success).toBe(true);
  });

  it('accepts up to three questions', () => {
    const result = RequestUserInputArgsSchema.safeParse({
      questions: [
        makeQuestion(),
        makeQuestion({ id: 'notify', header: 'Notify', question: 'Send notifications?' }),
        makeQuestion({ id: 'schedule', header: 'Schedule', question: 'When should it run?' }),
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than three questions', () => {
    const result = RequestUserInputArgsSchema.safeParse({
      questions: [
        makeQuestion({ id: 'q1' }),
        makeQuestion({ id: 'q2' }),
        makeQuestion({ id: 'q3' }),
        makeQuestion({ id: 'q4' }),
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects fewer than two options', () => {
    const result = RequestUserInputArgsSchema.safeParse({
      questions: [makeQuestion({ options: [{ id: 'only', label: 'Only', description: 'The only choice' }] })],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than four options', () => {
    const result = RequestUserInputArgsSchema.safeParse({
      questions: [makeQuestion({
        options: [
          { id: 'a', label: 'A', description: 'Option A' },
          { id: 'b', label: 'B', description: 'Option B' },
          { id: 'c', label: 'C', description: 'Option C' },
          { id: 'd', label: 'D', description: 'Option D' },
          { id: 'e', label: 'E', description: 'Option E' },
        ],
      })],
    });
    expect(result.success).toBe(false);
  });

  it('rejects ids with invalid characters or over 64 chars', () => {
    expect(RequestUserInputArgsSchema.safeParse({ questions: [makeQuestion({ id: 'bad id!' })] }).success).toBe(false);
    expect(RequestUserInputArgsSchema.safeParse({ questions: [makeQuestion({ id: 'x'.repeat(65) })] }).success).toBe(false);
    expect(RequestUserInputArgsSchema.safeParse({ questions: [makeQuestion({ id: 'x'.repeat(64) })] }).success).toBe(true);
  });

  it('enforces header/question/label/description length caps after trim', () => {
    expect(RequestUserInputArgsSchema.safeParse({ questions: [makeQuestion({ header: 'x'.repeat(25) })] }).success).toBe(false);
    expect(RequestUserInputArgsSchema.safeParse({ questions: [makeQuestion({ header: '  x'.repeat(1) + 'x'.repeat(20) })] }).success).toBe(true);
    expect(RequestUserInputArgsSchema.safeParse({ questions: [makeQuestion({ question: 'x'.repeat(501) })] }).success).toBe(false);
    expect(RequestUserInputArgsSchema.safeParse({
      questions: [makeQuestion({ options: [{ id: 'a', label: 'x'.repeat(81), description: 'ok' }, { id: 'b', label: 'B', description: 'ok' }] })],
    }).success).toBe(false);
    expect(RequestUserInputArgsSchema.safeParse({
      questions: [makeQuestion({ options: [{ id: 'a', label: 'A', description: 'x'.repeat(241) }, { id: 'b', label: 'B', description: 'ok' }] })],
    }).success).toBe(false);
    expect(RequestUserInputArgsSchema.safeParse({ questions: [makeQuestion({ header: '   ' })] }).success).toBe(false);
  });
});

describe('validateRequestUserInputArgs (cross-field rules)', () => {
  it('rejects duplicate question ids', () => {
    const issues = validateRequestUserInputArgs({ questions: [makeQuestion(), makeQuestion()] });
    expect(issues.some(i => i.message.includes('duplicate question id'))).toBe(true);
  });

  it('rejects duplicate option ids within a question but allows reuse across questions', () => {
    const dup = validateRequestUserInputArgs({
      questions: [makeQuestion({ options: [
        { id: 'same', label: 'A', description: 'dup a' },
        { id: 'same', label: 'B', description: 'dup b' },
      ] })],
    });
    expect(dup.some(i => i.message.includes('duplicate option id'))).toBe(true);

    const reuse = validateRequestUserInputArgs({
      questions: [
        makeQuestion(),
        makeQuestion({ id: 'second', header: 'Second', question: 'Second question?' }),
      ],
    });
    expect(reuse).toHaveLength(0);
  });

  it('rejects the reserved __other__ id on options and questions', () => {
    const optIssues = validateRequestUserInputArgs({
      questions: [makeQuestion({ options: [
        { id: REQUEST_USER_INPUT_OTHER_OPTION_ID, label: 'Other', description: 'reserved' },
        { id: 'b', label: 'B', description: 'ok' },
      ] })],
    });
    expect(optIssues.some(i => i.message.includes('reserved id'))).toBe(true);

    const qIssues = validateRequestUserInputArgs({
      questions: [makeQuestion({ id: REQUEST_USER_INPUT_OTHER_OPTION_ID }), makeQuestion({ id: 'other-question' })],
    });
    expect(qIssues.some(i => i.message.includes('reserved id'))).toBe(true);
  });

  it('rejects more than one recommended option per question', () => {
    const issues = validateRequestUserInputArgs({
      questions: [makeQuestion({ options: [
        { id: 'a', label: 'A', description: 'first', recommended: true },
        { id: 'b', label: 'B', description: 'second', recommended: true },
      ] })],
    });
    expect(issues.some(i => i.message.includes('recommended'))).toBe(true);
  });

  it('rejects exclusive on single-select questions but allows it on multi-select', () => {
    const single = validateRequestUserInputArgs({
      questions: [makeQuestion({ options: [
        { id: 'none', label: 'None', description: 'No notifications', exclusive: true },
        { id: 'all', label: 'All', description: 'All notifications' },
      ] })],
    });
    expect(single.some(i => i.message.includes('exclusive'))).toBe(true);

    const multi = validateRequestUserInputArgs({
      questions: [makeQuestion({
        multiple: true,
        options: [
          { id: 'none', label: 'None', description: 'No notifications', exclusive: true },
          { id: 'email', label: 'Email', description: 'Email notifications' },
        ],
      })],
    });
    expect(multi).toHaveLength(0);
  });
});

describe('parseRequestUserInputArgs', () => {
  it('returns ok with trimmed data', () => {
    const result = parseRequestUserInputArgs({ questions: [makeQuestion({ header: '  Data  ' })] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.questions[0]?.header).toBe('Data');
    }
  });

  it('aggregates schema and cross-field failures into one message', () => {
    const bad = parseRequestUserInputArgs({ questions: [] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain('at least one question');
    }

    const dup = parseRequestUserInputArgs({ questions: [makeQuestion(), makeQuestion()] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error).toContain('duplicate question id');
    }
  });
});

describe('request_user_input registry entry + filtering', () => {
  it('is registered with allow safe-mode and a handler', () => {
    const def = SESSION_TOOL_REGISTRY.get('request_user_input');
    expect(def).toBeDefined();
    expect(def?.safeMode).toBe('allow');
    expect(def?.executionMode).toBe('registry');
    expect(def?.handler).not.toBeNull();
  });

  it('is filtered out by default (fail closed) and included when allowed', () => {
    const names = (defs: { name: string }[]) => new Set(defs.map(d => d.name));
    expect(names(getSessionToolDefs()).has('request_user_input')).toBe(false);
    expect(names(getSessionToolDefs({ allowRequestUserInput: false })).has('request_user_input')).toBe(false);
    expect(names(getSessionToolDefs({ allowRequestUserInput: true })).has('request_user_input')).toBe(true);

    const jsonNames = names(getToolDefsAsJsonSchema({ allowRequestUserInput: true }));
    expect(jsonNames.has('request_user_input')).toBe(true);
    const jsonNamesClosed = names(getToolDefsAsJsonSchema({}));
    expect(jsonNamesClosed.has('request_user_input')).toBe(false);
  });

  it('keeps request_user_input in the canonical unfiltered registry', () => {
    expect(SESSION_TOOL_DEFS.some(d => d.name === 'request_user_input')).toBe(true);
  });
});

describe('handleRequestUserInput', () => {
  it('invokes onQuestionRequested with validated questions and returns a waiting result', async () => {
    const received: RequestUserInputQuestionArgs[][] = [];
    const ctx = makeCtx({
      onQuestionRequested: (questions) => { received.push(questions); },
    });

    const result = await handleRequestUserInput(ctx, { questions: [makeQuestion({ question: '  How now?  ' })] });
    expect(result.isError).toBeFalsy();
    expect(received).toHaveLength(1);
    expect(received[0]?.[0]?.question).toBe('How now?');
    expect(result.content[0]?.text).toContain('Waiting');
  });

  it('awaits a delayed callback — the tool result settles only after the durable handoff', async () => {
    let releaseCallback: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { releaseCallback = resolve; });
    let callbackDone = false;
    const ctx = makeCtx({
      onQuestionRequested: () => gate.then(() => { callbackDone = true; }),
    });

    const handlerPromise = handleRequestUserInput(ctx, { questions: [makeQuestion()] });
    let settled = false;
    void handlerPromise.then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(callbackDone).toBe(false);

    releaseCallback!();
    const result = await handlerPromise;
    expect(callbackDone).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('Waiting');
  });

  it('converts a rejected callback into an error response (never a fake paused success)', async () => {
    const ctx = makeCtx({
      onQuestionRequested: () => Promise.reject(new Error('disk full')),
    });

    const result = await handleRequestUserInput(ctx, { questions: [makeQuestion()] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('disk full');
    expect(result.content[0]?.text).toContain('NOT paused');
  });

  it('returns an error response when the callback is unavailable', async () => {
    const ctx = makeCtx({});
    const result = await handleRequestUserInput(ctx, { questions: [makeQuestion()] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not available');
  });

  it('rejects invalid arguments without invoking the callback', async () => {
    let called = false;
    const ctx = makeCtx({ onQuestionRequested: () => { called = true; } });
    const result = await handleRequestUserInput(ctx, { questions: [makeQuestion(), makeQuestion()] });
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });
});
