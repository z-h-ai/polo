/**
 * Session MCP Server Launcher (review fix round 8/9, issue B)
 *
 * The canonical per-turn spawn construction lives in
 * `@polo-ai/shared/agent` (session-lifecycle) so the production runtime
 * resolver can consume it; this module re-exports it for the server package.
 */
export { buildSessionMcpServerArgs } from '@polo-ai/shared/agent';
export type { SessionMcpSpawnOptions } from '@polo-ai/shared/agent';
