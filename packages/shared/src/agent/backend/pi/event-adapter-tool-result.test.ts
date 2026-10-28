/**
 * Tests for tool_execution_end result extraction.
 *
 * The Pi SDK fires tool_execution_end with the bare content-block array
 * (AgentToolResult wrapper stripped). Regression guard for POO-161: the old
 * JSON.stringify fallback escaped the quotes of generate_app's embedded
 * [genui-app …] marker, so the renderer could never parse the bundle path and
 * every canvas entry point (inline open button, sidebar pane, popout) vanished.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function collect<T>(gen: Generator<T>): T[] {
  return [...gen];
}

const MARKER = '[genui-app id="app-abc" version="1" path="/sessions/s1/data/genui-apps/app-abc/index.html"]';

function toolEndEvents(adapter: PiEventAdapter, result: unknown): any[] {
  collect(adapter.adaptEvent({
    type: 'tool_execution_start',
    toolCallId: 'tc1',
    toolName: 'generate_app',
    args: { title: 't', html: '<p>x</p>' },
  } as any));
  return collect(adapter.adaptEvent({
    type: 'tool_execution_end',
    toolCallId: 'tc1',
    result,
  } as any));
}

describe('PiEventAdapter — tool_execution_end result extraction', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('extracts plain text from a bare content-block array (Pi SDK event shape)', () => {
    const events = toolEndEvents(adapter, [
      { type: 'text', text: `App created.\n${MARKER}` },
    ]);

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toBeDefined();
    expect(result.result).toBe(`App created.\n${MARKER}`);
    expect(result.result).not.toContain('\\"');
  });

  it('joins multiple text blocks from a bare array', () => {
    const events = toolEndEvents(adapter, [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ]);

    const result = events.find((e) => e.type === 'tool_result');
    expect(result.result).toBe('line one\nline two');
  });

  it('still unwraps the { content: [...] } AgentToolResult shape', () => {
    const events = toolEndEvents(adapter, {
      content: [{ type: 'text', text: MARKER }],
      details: undefined,
    });

    const result = events.find((e) => e.type === 'tool_result');
    expect(result.result).toBe(MARKER);
  });

  it('falls back to JSON for non-text bare arrays', () => {
    const events = toolEndEvents(adapter, [{ foo: 1 }]);

    const result = events.find((e) => e.type === 'tool_result');
    expect(result.result).toBe(JSON.stringify([{ foo: 1 }]));
  });
});
