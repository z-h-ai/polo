/**
 * MCP client using official @modelcontextprotocol/sdk
 * Supports both HTTP and stdio transports for remote and local MCP servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  TOOL_ENV_ALLOWLIST,
  createSanitizedEnv,
} from '@polo-ai/session-tools-core';

/**
 * HTTP transport config for remote MCP servers
 */
export interface HttpMcpClientConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Stdio transport config for local MCP servers (spawns subprocess)
 */
export interface StdioMcpClientConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Unified config supporting both transport types
 */
export type McpClientConfig = HttpMcpClientConfig | StdioMcpClientConfig;

export type McpEnvironmentPolicy = 'desktop' | 'cli-one-shot';

export interface PoloMcpClientOptions {
  environmentPolicy?: McpEnvironmentPolicy;
}

/**
 * Sensitive environment variables that should NOT be passed to MCP subprocesses.
 * These could contain API keys, tokens, or credentials that MCP servers don't need
 * and shouldn't have access to.
 * NOTE: This list is duplicated in packages/session-tools-core/src/handlers/transform-data.ts (BLOCKED_ENV_VARS).
 * If you add a new entry here, update it there too.
 */
const BLOCKED_ENV_VARS = [
  // Polo AI auth (set by the app itself)
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',

  // AWS credentials
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',

  // Common API keys/tokens
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
];

const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:api_?key|access_?token|auth(?:orization)?|bearer|credential|oauth|password|private_?key|secret|token)(?:_|$)/i;
const CREDENTIAL_ENV_VALUE = [
  /^(?:Bearer|Basic)\s+\S+/i,
  /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/,
  /\b(?:oauth|token|secret|credential)[-_][A-Za-z0-9._-]{8,}\b/i,
  /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/,
];

function containsCredentialLikeValue(value: string): boolean {
  return CREDENTIAL_ENV_VALUE.some((pattern) => pattern.test(value));
}

function buildCliOneShotStdioEnv(
  configuredEnv: Record<string, string> | undefined,
): Record<string, string> {
  const env = createSanitizedEnv(process.env, true) as Record<string, string>;
  for (const [key, value] of Object.entries(configuredEnv ?? {})) {
    if (CREDENTIAL_ENV_NAME.test(key) || containsCredentialLikeValue(value)) {
      throw new Error(
        `CLI one-shot stdio MCP environment rejects credential-like variable: ${key}`,
      );
    }
    if (TOOL_ENV_ALLOWLIST.has(key) || key.startsWith('LC_')) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Interface for clients managed by McpClientPool.
 * Both PoloMcpClient (remote MCP sources) and ApiSourcePoolClient (API sources) implement this.
 */
export interface PoolClient {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export class PoloMcpClient {
  private client: Client;
  private transport: Transport;
  private connected = false;

  constructor(
    config: McpClientConfig,
    options: PoloMcpClientOptions = {},
  ) {
    this.client = new Client({
      name: 'polo-ai',
      version: '1.0.0',
    });

    // Create transport based on config type
    if (config.transport === 'stdio') {
      const environmentPolicy = options.environmentPolicy
        ?? (process.env.POLO_AI_RUNTIME_PROFILE === 'cli-one-shot'
          ? 'cli-one-shot'
          : 'desktop');
      const processEnv: Record<string, string> = {};
      if (environmentPolicy === 'desktop') {
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
            processEnv[key] = value;
          }
        }
      }
      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: environmentPolicy === 'cli-one-shot'
          ? buildCliOneShotStdioEnv(config.env)
          : { ...processEnv, ...config.env },
      });
    } else {
      // HTTP transport for remote MCP servers
      this.transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: {
            headers: config.headers,
          },
        }
      );
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    await this.client.connect(this.transport);

    // Verify connection works by listing tools
    try {
      await this.client.listTools();
    } catch (error) {
      await this.client.close();
      throw new Error(
        `MCP connection failed health check: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.connected = true;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.listTools();
    return result.tools;
  }

  /**
   * Returns server name/version reported during the MCP handshake.
   * Available after `connect()` resolves; undefined otherwise.
   */
  getServerInfo(): { name: string; version: string } | undefined {
    const info = this.client.getServerVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.callTool({ name, arguments: args });
    return result;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}
