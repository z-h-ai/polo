/**
 * PermissionManager - Centralized Tool Permission Evaluation
 *
 * Provides a unified interface for checking tool permissions that both
 * ClaudeAgent and PiAgent can use. Delegates to the existing mode-manager
 * implementation to ensure consistent behavior.
 *
 * Key responsibilities:
 * - Evaluate tool calls against permission mode (explore/ask/execute)
 * - Check bash commands against read-only patterns
 * - Validate API endpoints against allowlists
 * - Provide detailed rejection reasons for blocked operations
 */

import { homedir } from 'os';
import {
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  shouldAllowToolInMode,
  isApiEndpointAllowed,
  getBashRejectionReason,
  formatBashRejectionMessage,
  type ToolCheckResult,
} from '../mode-manager.ts';
import { createLogger } from '../../utils/debug.ts';
import { permissionsConfigCache, type PermissionsContext } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';
import type { PermissionManagerConfig, ToolPermissionResult } from './types.ts';

const log = createLogger('permissions');

// Re-export types for convenience
export type { ToolCheckResult, PermissionMode };

/**
 * Dangerous commands that should always require permission in 'ask' mode.
 * These are never auto-allowed regardless of user configuration.
 */
const DANGEROUS_COMMANDS = new Set([
  'rm', 'rmdir', 'sudo', 'su', 'chmod', 'chown', 'chgrp',
  'mv', 'cp', 'dd', 'mkfs', 'fdisk', 'parted',
  'kill', 'killall', 'pkill',
  'reboot', 'shutdown', 'halt', 'poweroff',
  'curl', 'wget', 'ssh', 'scp', 'rsync',
  'git push', 'git reset', 'git rebase', 'git checkout',
]);

/**
 * POO-179: the legacy "Always Allow" whitelist write target, resolved from the
 * original `(baseCommand, command)` pair of a pending permission. `kind`
 * distinguishes the domain write (curl/wget) from the command write so the
 * legacy respond side effect and the read-only presentation eligible check
 * share one resolution source.
 */
export interface LegacyAlwaysAllowTarget {
  kind: 'domain' | 'command';
  key: string;
}

/**
 * PermissionManager provides centralized permission checking for agent backends.
 *
 * Usage:
 * ```typescript
 * const permManager = new PermissionManager({
 *   workspaceId: workspace.id,
 *   sessionId: session.id,
 *   workingDirectory: session.workingDirectory,
 *   plansFolderPath: getSessionPlansPath(workspace, session.id),
 * });
 *
 * // Check if a tool call is allowed
 * const result = permManager.evaluateToolCall('Bash', { command: 'git status' });
 * if (!result.allowed) {
 *   // Block with reason
 * }
 * ```
 */
export class PermissionManager {
  private config: PermissionManagerConfig;
  private permissionsContext: PermissionsContext;

  // Session-scoped whitelists for "always allow" feature
  private alwaysAllowedCommands: Set<string> = new Set();
  private alwaysAllowedDomains: Set<string> = new Set();

  constructor(config: PermissionManagerConfig) {
    this.config = config;
    // Build permissions context for loading custom permissions
    // PermissionsContext expects workspaceRootPath (absolute path to workspace)
    this.permissionsContext = {
      workspaceRootPath: config.workingDirectory ?? '',
    };
  }

  // ============================================================
  // Permission Mode Management
  // ============================================================

  /**
   * Get the current permission mode for this session.
   */
  getPermissionMode(): PermissionMode {
    return getPermissionMode(this.config.sessionId);
  }

  /**
   * Set the permission mode for this session.
   */
  setPermissionMode(mode: PermissionMode): void {
    setPermissionMode(this.config.sessionId, mode);
  }

  /**
   * Cycle to the next permission mode (explore → ask → execute → explore).
   * Returns the new mode.
   */
  cyclePermissionMode(enabledModes?: PermissionMode[]): PermissionMode {
    return cyclePermissionMode(this.config.sessionId, enabledModes);
  }

  // ============================================================
  // Tool Permission Evaluation
  // ============================================================

  /**
   * Evaluate whether a tool call is allowed under the current permission mode.
   *
   * This is the main entry point for permission checking. It considers:
   * - Current permission mode (explore/ask/execute)
   * - Tool type (Bash, Write, MCP, API, etc.)
   * - Tool input parameters
   * - Custom permission rules from permissions.json
   *
   * @param toolName - Name of the tool being called
   * @param toolInput - Input parameters for the tool
   * @returns ToolPermissionResult with allowed status and reason if blocked
   */
  evaluateToolCall(
    toolName: string,
    toolInput: Record<string, unknown>
  ): ToolPermissionResult {
    const mode = this.getPermissionMode();

    // Use shouldAllowToolInMode which handles all the complex logic
    const result = shouldAllowToolInMode(toolName, toolInput, mode, {
      plansFolderPath: this.config.plansFolderPath,
      dataFolderPath: this.config.dataFolderPath,
      permissionsContext: this.permissionsContext,
    });

    if (result.allowed) {
      if ('requiresPermission' in result && result.requiresPermission) {
        log.info('Tool requires permission', {
          sessionId: this.config.sessionId,
          mode,
          toolName,
          description: result.description,
          toolInput,
        });
        return {
          allowed: true,
          requiresPermission: true,
          description: result.description,
        };
      }
      log.debug('Tool allowed', {
        sessionId: this.config.sessionId,
        mode,
        toolName,
      });
      return { allowed: true };
    }

    log.warn('Tool blocked', {
      sessionId: this.config.sessionId,
      mode,
      toolName,
      reason: result.reason,
      toolInput,
    });

    return {
      allowed: false,
      reason: result.reason,
    };
  }

  /**
   * Check if a bash command is allowed in the current mode.
   * Returns detailed rejection reason if blocked.
   *
   * @param command - The bash command to check
   * @returns null if allowed, or rejection reason string if blocked
   */
  checkBashCommand(command: string): string | null {
    const mode = this.getPermissionMode();

    // In execute mode, all commands are allowed
    if (mode === 'allow-all') {
      return null;
    }

    // In ask mode, commands are allowed but may require confirmation
    if (mode === 'ask') {
      return null;
    }

    // In explore mode, check against read-only patterns
    const config = permissionsConfigCache.getMergedConfig(this.permissionsContext);
    const rejection = getBashRejectionReason(command, config);

    if (!rejection) {
      return null;
    }

    return formatBashRejectionMessage(rejection, config);
  }

  /**
   * Check if a bash command requires user permission in 'ask' mode.
   * Dangerous commands always require permission.
   *
   * @param command - The bash command to check
   * @returns true if permission should be requested
   */
  requiresBashPermission(command: string): boolean {
    const mode = this.getPermissionMode();

    // Execute mode never requires permission
    if (mode === 'allow-all') {
      return false;
    }

    // Explore mode blocks commands, doesn't ask
    if (mode === 'safe') {
      return false;
    }

    // In ask mode, check if command is dangerous
    const baseCommand = this.getBaseCommand(command);
    return this.isDangerousCommand(baseCommand);
  }

  // ============================================================
  // API Endpoint Checking
  // ============================================================

  /**
   * Check if an API endpoint is allowed based on method and path.
   * GET requests are always allowed. Other methods check against allowlist.
   *
   * @param method - HTTP method (GET, POST, etc.)
   * @param path - API endpoint path
   * @returns true if the endpoint is allowed
   */
  isApiEndpointAllowed(method: string, path?: string): boolean {
    return isApiEndpointAllowed(method, path, this.permissionsContext);
  }

  // ============================================================
  // Command Analysis Utilities
  // ============================================================

  /**
   * Extract the base command (first word) from a bash command string.
   * Handles pipes, redirects, and other shell constructs.
   *
   * @param command - Full bash command
   * @returns Base command name
   */
  getBaseCommand(command: string): string {
    const trimmed = command.trim();
    // Extract first word, handling common prefixes
    const match = trimmed.match(/^(?:sudo\s+)?(\S+)/);
    return match?.[1] ?? trimmed.split(/\s+/)[0] ?? '';
  }

  /**
   * Check if a command is in the dangerous commands list.
   *
   * @param baseCommand - Base command name (from getBaseCommand)
   * @returns true if command is dangerous
   */
  isDangerousCommand(baseCommand: string): boolean {
    return DANGEROUS_COMMANDS.has(baseCommand.toLowerCase());
  }

  /**
   * Extract domain from network commands (curl, wget, ssh, etc.)
   * Used for domain whitelisting checks.
   *
   * @param command - Full bash command
   * @returns Domain if found, null otherwise
   */
  extractDomainFromNetworkCommand(command: string): string | null {
    // Match common patterns for URLs and hostnames
    const urlMatch = command.match(/https?:\/\/([^\/\s:]+)/);
    if (urlMatch?.[1]) {
      return urlMatch[1];
    }

    // Match ssh-style user@host patterns
    const sshMatch = command.match(/@([^\s:]+)/);
    if (sshMatch?.[1]) {
      return sshMatch[1];
    }

    return null;
  }

  /**
   * Single source of the legacy "Always Allow" whitelist write target.
   *
   * Mirrors the historical ClaudeAgent.respondToPermission branch exactly:
   * curl/wget whitelist the extracted domain (nothing when no domain is
   * extractable), any other non-dangerous base command whitelists itself, and
   * dangerous base commands write nothing. Callers pass the ORIGINAL
   * `(baseCommand, command)` pair captured on the pending permission — the
   * getBaseCommand parsing itself is NOT redone here.
   *
   * Used by both the legacy respond side effect and the read-only presentation
   * eligible check so the two can never drift.
   *
   * @param baseCommand - Base command captured on the pending permission
   * @param command - Full command captured on the pending permission
   * @returns The target the legacy respond would write, or null when it writes nothing
   */
  resolveLegacyAlwaysAllowTarget(baseCommand: string, command: string): LegacyAlwaysAllowTarget | null {
    if (baseCommand === 'curl' || baseCommand === 'wget') {
      // For curl/wget, whitelist the domain instead of the command
      const domain = this.extractDomainFromNetworkCommand(command);
      return domain ? { kind: 'domain', key: domain } : null;
    }
    if (!this.isDangerousCommand(baseCommand)) {
      return { kind: 'command', key: baseCommand };
    }
    return null;
  }

  /**
   * Read-only presentation metadata for permission prompts: whether clicking
   * "Always Allow" on this request would remember it for this session.
   *
   * POO-179: this only decides whether the UI may show the existing Always
   * Allow action. It is NOT an authorization credential, never enters
   * PermissionResponseOptions, and never changes grant rules or the legacy
   * respond side effects.
   *
   * Eligible is deliberately decoupled from the legacy write target: the
   * legacy respond keeps writing its historical (sometimes mismatched) target,
   * while eligible is true only when that target is also the key the canonical
   * lookup consults for the same request — i.e. a second identical request
   * would really be auto-allowed.
   *
   * @param input - promptType plus the original (toolName, command, baseCommand) of THIS request
   * @returns true only when the legacy target matches the canonical lookup key
   */
  canRememberForSession(input: {
    promptType: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval' | 'browser_action' | string;
    toolName: string;
    command: string;
    baseCommand: string;
  }): boolean {
    // Admin approval has its own session+commandHash remember window and the
    // browser_action branch has none; the normal card must not promise either.
    if (input.promptType !== 'bash' && input.promptType !== 'file_write' && input.promptType !== 'mcp_mutation' && input.promptType !== 'api_mutation') {
      return false;
    }
    const target = this.resolveLegacyAlwaysAllowTarget(input.baseCommand, input.command);
    if (!target || !target.key) return false;
    if (target.kind === 'domain') {
      // The domain whitelist is only consulted by the canonical curl/wget
      // branch, which extracts the domain from the same command.
      return input.baseCommand === 'curl' || input.baseCommand === 'wget';
    }
    // Command target: the canonical lookup must consult the SAME key.
    const canonicalLookupKey =
      input.promptType === 'bash'
        ? input.baseCommand
        : input.promptType === 'mcp_mutation'
          ? input.toolName
          : input.promptType === 'file_write'
            ? input.toolName
            : input.command; // api_mutation: full "METHOD path" key
    return canonicalLookupKey === target.key;
  }

  // ============================================================
  // Context Management
  // ============================================================

  /**
   * Update the working directory (used for permission context).
   */
  updateWorkingDirectory(path: string): void {
    this.config.workingDirectory = path;
    this.permissionsContext.workspaceRootPath = path;
  }

  /**
   * Update the plans folder path.
   */
  updatePlansFolderPath(path: string): void {
    this.config.plansFolderPath = path;
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string {
    return this.config.sessionId;
  }

  /**
   * Get the permissions context for external use.
   */
  getPermissionsContext(): PermissionsContext {
    return this.permissionsContext;
  }

  // ============================================================
  // Session-Scoped Whitelisting
  // ============================================================

  /**
   * Check if a base command has been whitelisted for this session.
   */
  isCommandWhitelisted(baseCommand: string): boolean {
    return this.alwaysAllowedCommands.has(baseCommand.toLowerCase());
  }

  /**
   * Whitelist a command for the remainder of the session.
   * Called when user clicks "Always Allow" for a command.
   */
  whitelistCommand(baseCommand: string): void {
    this.alwaysAllowedCommands.add(baseCommand.toLowerCase());
  }

  /**
   * Check if a domain has been whitelisted for network commands.
   */
  isDomainWhitelisted(domain: string): boolean {
    return this.alwaysAllowedDomains.has(domain.toLowerCase());
  }

  /**
   * Whitelist a domain for network commands.
   * Called when user clicks "Always Allow" for curl/wget to a domain.
   */
  whitelistDomain(domain: string): void {
    this.alwaysAllowedDomains.add(domain.toLowerCase());
  }

  /**
   * Clear all session-scoped whitelists.
   * Called on session clear or dispose.
   */
  clearWhitelists(): void {
    this.alwaysAllowedCommands.clear();
    this.alwaysAllowedDomains.clear();
  }

  /**
   * Get the set of whitelisted commands (for debugging).
   */
  getWhitelistedCommands(): Set<string> {
    return new Set(this.alwaysAllowedCommands);
  }

  /**
   * Get the set of whitelisted domains (for debugging).
   */
  getWhitelistedDomains(): Set<string> {
    return new Set(this.alwaysAllowedDomains);
  }
}
