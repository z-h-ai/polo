import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { PermissionMode } from '@polo-ai/shared/agent/modes'
import type { RpcServer, RequestContext } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import type { CliExecutionAuthority } from '../../sessions/cli-execution-authority'

const modes = new Set(['safe', 'ask', 'allow-all'])
const exactKeys = (value: object, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('CLI_RPC_ARGUMENT_REJECTED')
}
const directory = async (path: unknown) => {
  if (typeof path !== 'string' || !isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('CLI_WORKING_DIRECTORY_REQUIRED')
  return path
}

/** No core/admin/settings/file/transfer handlers are registered in this runtime. */
export function registerCliExecutionHandlers(server: RpcServer, deps: HandlerDeps, authority: CliExecutionAuthority): void {
  const sm = deps.sessionManager
  const caller = (ctx: RequestContext, sessionId?: string) => {
    authority.assertClient(ctx.workspaceId, ctx.clientId)
    if (sessionId !== undefined) {
      authority.assertSession(sessionId)
      if (!sm.assertCliSessionOwned) throw new Error('CLI_EXECUTION_AUTHORITY_REQUIRED')
      sm.assertCliSessionOwned(sessionId)
    }
  }
  server.handle(RPC_CHANNELS.sessions.CREATE, async (ctx, workspaceId: string, options: Record<string, any> = {}) => {
    caller(ctx)
    if (workspaceId !== authority.bootstrap.workspace.id) throw new Error('CLI_EXECUTION_SCOPE_REQUIRED')
    exactKeys(options, ['permissionMode', 'enabledSourceSlugs', 'workingDirectory', 'hidden', 'origin', 'model', 'llmConnection'])
    if (options.origin && options.origin !== authority.bootstrap.origin) throw new Error('CLI_RPC_ARGUMENT_REJECTED')
    if (!modes.has(options.permissionMode) || (options.enabledSourceSlugs !== undefined && (!Array.isArray(options.enabledSourceSlugs) || !options.enabledSourceSlugs.every((s: unknown) => typeof s === 'string')))) throw new Error('CLI_RPC_ARGUMENT_REJECTED')
    if (options.llmConnection !== authority.bootstrap.connection?.slug || (options.model != null && typeof options.model !== 'string')) throw new Error('CLI_EXECUTION_CONNECTION_REQUIRED')
    const workingDirectory = await directory(options.workingDirectory)
    caller(ctx)
    authority.beginCreate()
    const session = await sm.createSession(workspaceId, {
      permissionMode: options.permissionMode, enabledSourceSlugs: options.enabledSourceSlugs,
      workingDirectory, hidden: true, origin: authority.bootstrap.origin,
      model: options.model, llmConnection: options.llmConnection,
    })
    authority.bindCreated(session.id)
    caller(ctx, session.id)
    return session
  })
  server.handle(RPC_CHANNELS.sessions.SEND_MESSAGE, async (ctx, sessionId: string, message: string, attachments?: unknown, stored?: unknown, options: Record<string, unknown> = {}) => {
    caller(ctx, sessionId)
    exactKeys(options, ['invocationSource'])
    if (typeof message !== 'string' || attachments != null || stored != null || (options.invocationSource && options.invocationSource !== 'headless')) throw new Error('CLI_RPC_ARGUMENT_REJECTED')
    return new Promise((resolve, reject) => {
      let acked = false
      sm.sendMessage(sessionId, message, undefined, undefined, { invocationSource: 'headless' }, undefined, undefined, messageId => {
        try { caller(ctx, sessionId); acked = true; resolve({ accepted: true, messageId }) } catch (error) { reject(error) }
      }, { callerClientId: ctx.clientId }).then(() => {
        if (!acked) reject(new Error('CLI_SEND_NOT_ACKNOWLEDGED'))
      }, error => {
        if (!acked) { reject(error); return }
        // The same owner policy gates terminal errors as every other event.
        try {
          caller(ctx, sessionId)
          server.push(RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: ctx.clientId }, { type: 'error', sessionId, error: error instanceof Error ? error.message : 'Execution failed' })
          server.push(RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: ctx.clientId }, { type: 'complete', sessionId })
        } catch { /* revoked owners receive nothing */ }
      })
    })
  })
  server.handle(RPC_CHANNELS.sessions.CANCEL, (ctx, sessionId: string, silent?: boolean) => {
    caller(ctx, sessionId)
    if (silent !== undefined && typeof silent !== 'boolean') throw new Error('CLI_RPC_ARGUMENT_REJECTED')
    return sm.cancelProcessing(sessionId, silent)
  })
  server.handle(RPC_CHANNELS.sessions.COMMAND, async (ctx, sessionId: string, command: Record<string, any>) => {
    caller(ctx, sessionId)
    if (command.type === 'setPermissionMode') {
      exactKeys(command, ['type', 'mode'])
      if (!modes.has(command.mode)) throw new Error('CLI_RPC_ARGUMENT_REJECTED')
      return sm.setSessionPermissionMode(sessionId, command.mode as PermissionMode)
    }
    if (command.type === 'updateWorkingDirectory') {
      exactKeys(command, ['type', 'dir'])
      const path = await directory(command.dir)
      caller(ctx, sessionId)
      return sm.updateWorkingDirectory(sessionId, path)
    }
    throw new Error('CLI_COMMAND_UNSUPPORTED')
  })
  server.handle(RPC_CHANNELS.sessions.SET_MODEL, async (ctx, sessionId: string, workspaceId: string, model: string | null, connection?: string) => {
    caller(ctx, sessionId)
    if (workspaceId !== authority.bootstrap.workspace.id || connection !== authority.bootstrap.connection?.slug || (model !== null && typeof model !== 'string')) throw new Error('CLI_EXECUTION_CONNECTION_REQUIRED')
    return sm.updateSessionModel(sessionId, workspaceId, model, connection)
  })
}
