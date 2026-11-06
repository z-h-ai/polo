/**
 * POO-179 permission presentation metadata (`canRememberForSession`).
 *
 * The field is READ-ONLY presentation metadata: it only decides whether the
 * renderer may show the existing "Always Allow" action. It is not an
 * authorization credential, never enters `PermissionResponseOptions`, and must
 * not change any legacy respond side effect.
 *
 * Contract under test (technical-signoff-draft, origin/请求 matrix):
 * - eligible is DECOUPLED from the legacy write target: eligible=true only when
 *   the target the legacy respond would write is also the key the canonical
 *   lookup consults for the same request.
 * - every legacy respond side effect stays byte-for-byte, including the
 *   mismatched writes (file_write filepath base target, api method-only target).
 * - Pi / unknown / missing metadata render as false.
 *
 * Runs against the REAL PermissionManager, the REAL canonical
 * `shouldPromptInAskMode`, and the REAL Claude/Pi prompt emitters. External
 * SDK/IPC boundaries are mocked; `canRememberForSession` itself never is.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@polo-ai/core/types';

import { PermissionManager } from '../core/permission-manager.ts';
import { shouldPromptInAskMode } from '../core/pre-tool-use.ts';
import { initializeModeState, cleanupModeState } from '../mode-manager.ts';
import { createMockBackendConfig, createMockWorkspace, createMockSession } from './test-utils.ts';

const TEST_SESSION_ID = 'poo179-presentation-metadata';

// ============================================================
// Real Claude SDK mock (hook capture only — no network, no subprocess)
// ============================================================

const sdk = await import('@anthropic-ai/claude-agent-sdk');
type CapturedOptions = {
  hooks?: Record<string, Array<{ hooks: Array<(input: unknown, id: string, ctx: unknown) => Promise<unknown>> }>>;
};
let duringQuery: ((options: CapturedOptions) => Promise<void>) | undefined;
let captured: { options?: CapturedOptions } | undefined;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...sdk,
  query: ({ options }: { options?: CapturedOptions }) => {
    captured = { options };
    return {
      async *[Symbol.asyncIterator]() {
        if (duringQuery && options) await duringQuery(options);
        yield {
          type: 'result',
          subtype: 'success',
          result: 'unit',
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          session_id: 'poo179-sdk-unit',
        };
      },
      close() {},
    };
  },
}));

const { ClaudeAgent } = await import('../claude-agent.ts');
const { PiAgent } = await import('../pi-agent.ts');

type PermissionRequestPayload = {
  requestId: string;
  toolName: string;
  command?: string;
  description: string;
  type?: string;
  canRememberForSession?: boolean;
};

function makePermissionManager(sessionId = TEST_SESSION_ID): PermissionManager {
  return new PermissionManager({
    workspaceId: 'test-workspace',
    sessionId,
    workingDirectory: '/test/workspace',
    plansFolderPath: '/test/workspace/plans',
  });
}

async function drain(turn: AsyncGenerator<AgentEvent>): Promise<void> {
  const errors: unknown[] = [];
  for await (const event of turn) if (event.type === 'error') errors.push(event);
  expect(errors).toEqual([]);
}

/** Canonical lookup result: null means the request would be auto-allowed. */
function canonicalPrompt(pm: PermissionManager, toolName: string, input: Record<string, unknown>) {
  return shouldPromptInAskMode(toolName, input, pm, pm.getPermissionsContext(), '/test/workspace/plans');
}

describe('POO-179 permission presentation metadata (shared/agent side)', () => {
  let permissionManager: PermissionManager;

  beforeEach(() => {
    cleanupModeState(TEST_SESSION_ID);
    initializeModeState(TEST_SESSION_ID, 'ask');
    permissionManager = makePermissionManager();
  });

  // ----------------------------------------------------------
  // Pure eligible matrix (PermissionManager, no agents involved)
  // ----------------------------------------------------------
  describe('resolveLegacyAlwaysAllowTarget (single legacy write source)', () => {
    it('returns the command target for a non-dangerous base command', () => {
      expect(permissionManager.resolveLegacyAlwaysAllowTarget('npm', 'npm run build')).toEqual({
        kind: 'command',
        key: 'npm',
      });
    });

    it('returns the domain target for curl/wget with an extractable domain', () => {
      expect(permissionManager.resolveLegacyAlwaysAllowTarget('curl', 'curl https://Example.com/x')).toEqual({
        kind: 'domain',
        key: 'Example.com',
      });
      expect(permissionManager.resolveLegacyAlwaysAllowTarget('wget', 'wget http://example.org/f')).toEqual({
        kind: 'domain',
        key: 'example.org',
      });
    });

    it('returns null for curl/wget without a domain, dangerous bases, matching the legacy no-write branches', () => {
      expect(permissionManager.resolveLegacyAlwaysAllowTarget('curl', 'curl')).toBeNull();
      expect(permissionManager.resolveLegacyAlwaysAllowTarget('wget', 'wget --help')).toBeNull();
      expect(permissionManager.resolveLegacyAlwaysAllowTarget('rm', 'rm -rf build')).toBeNull();
      expect(permissionManager.resolveLegacyAlwaysAllowTarget('sudo', 'sudo apt-get update')).toBeNull();
    });
  });

  describe('canRememberForSession (pure presentation eligible matrix)', () => {
    it('bash non-dangerous non-empty base command is eligible', () => {
      expect(
        permissionManager.canRememberForSession({
          promptType: 'bash',
          toolName: 'Bash',
          command: 'npm run build',
          baseCommand: 'npm',
        }),
      ).toBe(true);
    });

    it('curl/wget with a domain is eligible; without a domain is false', () => {
      expect(
        permissionManager.canRememberForSession({
          promptType: 'bash',
          toolName: 'Bash',
          command: 'curl https://example.com/x',
          baseCommand: 'curl',
        }),
      ).toBe(true);
      expect(
        permissionManager.canRememberForSession({
          promptType: 'bash',
          toolName: 'Bash',
          command: 'curl',
          baseCommand: 'curl',
        }),
      ).toBe(false);
    });

    it('dangerous base command and empty command are false', () => {
      expect(
        permissionManager.canRememberForSession({
          promptType: 'bash',
          toolName: 'Bash',
          command: 'rm -rf build',
          baseCommand: 'rm',
        }),
      ).toBe(false);
      expect(
        permissionManager.canRememberForSession({
          promptType: 'bash',
          toolName: 'Bash',
          command: '',
          baseCommand: '',
        }),
      ).toBe(false);
    });

    it('mcp mutation with the exact full tool key is eligible', () => {
      const toolName = 'mcp__mysrv__createThing';
      expect(
        permissionManager.canRememberForSession({
          promptType: 'mcp_mutation',
          toolName,
          command: toolName,
          baseCommand: permissionManager.getBaseCommand(toolName),
        }),
      ).toBe(true);
    });

    it('file_write filepath base target does NOT match the toolName lookup: false', () => {
      expect(
        permissionManager.canRememberForSession({
          promptType: 'file_write',
          toolName: 'Write',
          command: '/test/workspace/notes/file.txt',
          baseCommand: permissionManager.getBaseCommand('/test/workspace/notes/file.txt'),
        }),
      ).toBe(false);
    });

    it('api mutation base method does NOT match the full method+path lookup: false', () => {
      expect(
        permissionManager.canRememberForSession({
          promptType: 'api_mutation',
          toolName: 'api_createRecord',
          command: 'POST /v1/records',
          baseCommand: permissionManager.getBaseCommand('POST /v1/records'),
        }),
      ).toBe(false);
    });

    it('admin approval is never session-remember eligible in the normal card', () => {
      expect(
        permissionManager.canRememberForSession({
          promptType: 'admin_approval',
          toolName: 'Bash',
          command: 'deploy --prod',
          baseCommand: 'deploy',
        }),
      ).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // Real two-request lookups (real PermissionManager + canonical shouldPrompt)
  // ----------------------------------------------------------
  describe('real two-request lookup proof', () => {
    it('bash same base: first prompt → legacy respond writes base → second identical request auto-allows', () => {
      const first = canonicalPrompt(permissionManager, 'Bash', { command: 'npm run build' });
      expect(first?.promptType).toBe('bash');
      expect(
        permissionManager.canRememberForSession({
          promptType: first!.promptType,
          toolName: 'Bash',
          command: first!.command!,
          baseCommand: permissionManager.getBaseCommand(first!.command!),
        }),
      ).toBe(true);

      // Legacy respond side effect (exactly what ClaudeAgent.respondToPermission does)
      const target = permissionManager.resolveLegacyAlwaysAllowTarget(
        permissionManager.getBaseCommand(first!.command!),
        first!.command!,
      );
      expect(target).toEqual({ kind: 'command', key: 'npm' });
      permissionManager.whitelistCommand(target!.key);

      expect(canonicalPrompt(permissionManager, 'Bash', { command: 'npm run build' })).toBeNull();
      // A different base command in the same session still prompts
      expect(canonicalPrompt(permissionManager, 'Bash', { command: 'python scripts/x.py' })?.promptType).toBe('bash');
    });

    it('bash eligibility does not cross sessions', () => {
      const other = makePermissionManager(`${TEST_SESSION_ID}-other`);
      other.whitelistCommand('npm');
      // The other session's whitelist is not consulted here
      expect(canonicalPrompt(permissionManager, 'Bash', { command: 'npm run build' })?.promptType).toBe('bash');
      expect(canonicalPrompt(other, 'Bash', { command: 'npm run build' })).toBeNull();
    });

    it('curl same domain: legacy domain write makes only the SAME domain auto-allow', () => {
      const command = 'curl https://example.com/x';
      const first = canonicalPrompt(permissionManager, 'Bash', { command });
      expect(first?.promptType).toBe('bash');
      expect(
        permissionManager.canRememberForSession({
          promptType: 'bash',
          toolName: 'Bash',
          command,
          baseCommand: 'curl',
        }),
      ).toBe(true);

      permissionManager.whitelistDomain('example.com');
      expect(canonicalPrompt(permissionManager, 'Bash', { command })).toBeNull();
      // A different domain still prompts
      expect(
        canonicalPrompt(permissionManager, 'Bash', { command: 'curl https://other.example.net/x' })?.promptType,
      ).toBe('bash');
    });

    it('curl without a domain is not eligible and the legacy respond writes no domain', () => {
      expect(
        permissionManager.canRememberForSession({
          promptType: 'bash',
          toolName: 'Bash',
          command: 'curl --help',
          baseCommand: 'curl',
        }),
      ).toBe(false);
      // Legacy respond: no domain extracted → no write
      expect(permissionManager.resolveLegacyAlwaysAllowTarget('curl', 'curl --help')).toBeNull();
      expect(permissionManager.getWhitelistedDomains().size).toBe(0);
    });

    it('dangerous base command: no eligibility, no legacy write, second request still prompts', () => {
      const command = 'rm -rf build';
      const first = canonicalPrompt(permissionManager, 'Bash', { command });
      expect(first?.promptType).toBe('bash');
      expect(
        permissionManager.canRememberForSession({
          promptType: 'bash',
          toolName: 'Bash',
          command,
          baseCommand: 'rm',
        }),
      ).toBe(false);
      expect(permissionManager.resolveLegacyAlwaysAllowTarget('rm', command)).toBeNull();
      expect(permissionManager.getWhitelistedCommands().size).toBe(0);
      expect(canonicalPrompt(permissionManager, 'Bash', { command })?.promptType).toBe('bash');
    });

    it('mcp exact tool key: eligible, only the SAME tool inherits', () => {
      const toolName = 'mcp__mysrv__createThing';
      const first = canonicalPrompt(permissionManager, toolName, { thing: 'a' });
      expect(first?.promptType).toBe('mcp_mutation');
      expect(first?.command).toBe(toolName);
      expect(
        permissionManager.canRememberForSession({
          promptType: 'mcp_mutation',
          toolName,
          command: first!.command!,
          baseCommand: permissionManager.getBaseCommand(first!.command!),
        }),
      ).toBe(true);

      // Legacy respond writes the resolved base command (= full tool key here)
      const target = permissionManager.resolveLegacyAlwaysAllowTarget(
        permissionManager.getBaseCommand(first!.command!),
        first!.command!,
      );
      expect(target).toEqual({ kind: 'command', key: toolName });
      permissionManager.whitelistCommand(target!.key);

      expect(canonicalPrompt(permissionManager, toolName, { thing: 'b' })).toBeNull();
      const otherTool = 'mcp__mysrv__deleteThing';
      expect(canonicalPrompt(permissionManager, otherTool, { thing: 'c' })?.promptType).toBe('mcp_mutation');
      expect(
        permissionManager.canRememberForSession({
          promptType: 'mcp_mutation',
          toolName: otherTool,
          command: otherTool,
          baseCommand: permissionManager.getBaseCommand(otherTool),
        }),
      ).toBe(true);
    });

    it('file_write: ineligible, yet the legacy respond still writes the filepath base target (old mismatch NOT repaired)', () => {
      const filePath = '/test/workspace/notes/file.txt';
      const first = canonicalPrompt(permissionManager, 'Write', { file_path: filePath });
      expect(first?.promptType).toBe('file_write');
      expect(first?.command).toBe(filePath);
      const baseCommand = permissionManager.getBaseCommand(first!.command!);
      expect(
        permissionManager.canRememberForSession({ promptType: 'file_write', toolName: 'Write', command: first!.command!, baseCommand }),
      ).toBe(false);

      // Legacy respond branch (unchanged): writes the filepath base target
      const target = permissionManager.resolveLegacyAlwaysAllowTarget(baseCommand, first!.command!);
      expect(target).toEqual({ kind: 'command', key: filePath });
      permissionManager.whitelistCommand(target!.key);
      expect(permissionManager.isCommandWhitelisted(filePath)).toBe(true);

      // The canonical lookup still keys by toolName → still prompts
      expect(canonicalPrompt(permissionManager, 'Write', { file_path: filePath })?.promptType).toBe('file_write');
    });

    it('api mutation: ineligible, yet the legacy respond still writes the bare method target', () => {
      const first = canonicalPrompt(permissionManager, 'api_createRecord', { method: 'POST', path: '/v1/records' });
      expect(first?.promptType).toBe('api_mutation');
      expect(first?.command).toBe('POST /v1/records');
      const baseCommand = permissionManager.getBaseCommand(first!.command!);
      expect(baseCommand).toBe('POST');
      expect(
        permissionManager.canRememberForSession({ promptType: 'api_mutation', toolName: 'api_createRecord', command: first!.command!, baseCommand }),
      ).toBe(false);

      const target = permissionManager.resolveLegacyAlwaysAllowTarget(baseCommand, first!.command!);
      expect(target).toEqual({ kind: 'command', key: 'POST' });
      permissionManager.whitelistCommand(target!.key);
      expect(permissionManager.isCommandWhitelisted('POST')).toBe(true);

      // Canonical lookup uses the full method+path key → still prompts
      expect(
        canonicalPrompt(permissionManager, 'api_createRecord', { method: 'POST', path: '/v1/records' })?.promptType,
      ).toBe('api_mutation');
    });

    it('unknown prompt type is never eligible', () => {
      expect(
        permissionManager.canRememberForSession({
          promptType: 'unknown' as never,
          toolName: 'SomeTool',
          command: 'some command',
          baseCommand: 'some',
        }),
      ).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // Real Claude prompt origin (PreToolUse hook) + real respond
  // ----------------------------------------------------------
  describe('real Claude PreToolUse prompt origin', () => {
    it('publishes eligible=true for a rememberable bash command and legacy respond keeps its write + second-request auto-allow', async () => {
      const root = await mkdtemp(join(tmpdir(), 'poo179-claude-perm-'));
      const authority = { load: async () => [], authorize: async () => {}, finish: async () => {} };
      const agent = new ClaudeAgent({
        ...createMockBackendConfig({
          workspace: createMockWorkspace({ rootPath: root }),
          session: createMockSession({ id: TEST_SESSION_ID, workspaceRootPath: root, workingDirectory: root }),
          canonicalSkills: authority,
        }),
        sessionCallbackOwnerToken: 'poo179-claude-owner',
      });
      try {
        const requests: PermissionRequestPayload[] = [];
        agent.onPermissionRequest = (request: PermissionRequestPayload) => {
          requests.push(request);
          // Real respond path with the "Always Allow" action
          agent.respondToPermission(request.requestId, true, true);
        };

        duringQuery = async (options) => {
          const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
          expect(hook).toBeDefined();

          // First request: prompt + eligible metadata
          const first = (await hook!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'poo179-t1', tool_input: { command: 'npm run build' } }, 'poo179-t1', {})) as { continue: boolean };
          expect(first.continue).toBe(true);

          // Second identical request: auto-allowed by the legacy write (no prompt)
          const before = requests.length;
          const second = (await hook!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'poo179-t2', tool_input: { command: 'npm run build' } }, 'poo179-t2', {})) as { continue: boolean };
          expect(second.continue).toBe(true);
          expect(requests.length).toBe(before);

          // A different base command still prompts, still eligible
          const third = (await hook!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'poo179-t3', tool_input: { command: 'python scripts/x.py' } }, 'poo179-t3', {})) as { continue: boolean };
          expect(third.continue).toBe(true);
        };

        await drain(agent.chat('permission metadata probe'));
        expect(requests).toHaveLength(2);
        expect(requests[0]!.canRememberForSession).toBe(true);
        expect(requests[0]!.requestId).toMatch(/^perm-/);
        expect(requests[0]!.command).toBe('npm run build');
        expect(requests[1]!.command).toBe('python scripts/x.py');
        expect(requests[1]!.canRememberForSession).toBe(true);

        // Legacy write reached the real PermissionManager
        const pm = (agent as unknown as { permissionManager: PermissionManager }).permissionManager;
        expect(pm.isCommandWhitelisted('npm')).toBe(true);
        expect(pm.isCommandWhitelisted('python')).toBe(true);
      } finally {
        duringQuery = undefined;
        agent.destroy();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('publishes eligible=false for dangerous / no-domain curl commands and never whitelists them', async () => {
      const root = await mkdtemp(join(tmpdir(), 'poo179-claude-perm-neg-'));
      const authority = { load: async () => [], authorize: async () => {}, finish: async () => {} };
      const agent = new ClaudeAgent({
        ...createMockBackendConfig({
          workspace: createMockWorkspace({ rootPath: root }),
          session: createMockSession({ id: `${TEST_SESSION_ID}-neg`, workspaceRootPath: root, workingDirectory: root }),
          canonicalSkills: authority,
        }),
        sessionCallbackOwnerToken: 'poo179-claude-owner-neg',
      });
      try {
        const requests: PermissionRequestPayload[] = [];
        agent.onPermissionRequest = (request: PermissionRequestPayload) => {
          requests.push(request);
          agent.respondToPermission(request.requestId, true, true);
        };

        duringQuery = async (options) => {
          const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
          for (const [id, command] of [['poo179-n1', 'rm -rf build'], ['poo179-n2', 'curl -s --max-time 2']] as const) {
            const result = (await hook!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command } }, id, {})) as { continue: boolean };
            expect(result.continue).toBe(true);
          }
        };

        await drain(agent.chat('permission negative probe'));
        expect(requests).toHaveLength(2);
        expect(requests[0]!.canRememberForSession).toBe(false);
        expect(requests[1]!.canRememberForSession).toBe(false);

        const pm = (agent as unknown as { permissionManager: PermissionManager }).permissionManager;
        expect(pm.getWhitelistedCommands().size).toBe(0);
        expect(pm.getWhitelistedDomains().size).toBe(0);
      } finally {
        duringQuery = undefined;
        agent.destroy();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  // ----------------------------------------------------------
  // Real Pi prompt origin: origin metadata false, alwaysAllow ignored
  // ----------------------------------------------------------
  describe('real Pi prompt origin', () => {
    it('publishes canRememberForSession=false and its respond ignores alwaysAllow (no whitelist write)', async () => {
      const agent = new PiAgent({
        provider: 'pi',
        workspace: { id: 'ws-poo179', name: 'Poo179', rootPath: '/tmp/poo179-pi' } as never,
        session: {
          id: `${TEST_SESSION_ID}-pi`,
          workspaceRootPath: '/tmp/poo179-pi',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        } as never,
        isHeadless: true,
      });
      try {
        const requests: PermissionRequestPayload[] = [];
        agent.onPermissionRequest = (request: PermissionRequestPayload) => {
          requests.push(request);
          // Pi's respond ignores _alwaysAllow entirely
          agent.respondToPermission(request.requestId, true, true);
        };
        const sent: Array<Record<string, unknown>> = [];
        (agent as unknown as { send: (msg: Record<string, unknown>) => void }).send = (msg) => sent.push(msg);

        await (agent as unknown as {
          handlePreToolUseRequest: (req: { requestId: string; toolName: string; input: Record<string, unknown> }) => Promise<void>;
        }).handlePreToolUseRequest({
          requestId: 'pi-perm-poo179-1',
          toolName: 'Bash',
          input: { command: 'npm run build' },
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]!.canRememberForSession).toBe(false);
        expect(requests[0]!.type).toBe('bash');
        expect(sent.at(-1)).toMatchObject({ type: 'pre_tool_use_response', requestId: 'pi-perm-poo179-1', action: 'allow' });

        const pm = (agent as unknown as { permissionManager: PermissionManager }).permissionManager;
        expect(pm.getWhitelistedCommands().size).toBe(0);
        expect(pm.getWhitelistedDomains().size).toBe(0);
      } finally {
        agent.destroy();
      }
    });
  });
});
