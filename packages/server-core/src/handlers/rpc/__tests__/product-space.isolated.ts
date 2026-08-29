import { beforeEach, describe, expect, it } from 'bun:test'
import type { HandlerDeps } from '../../handler-deps'
import {
  listProductSpaceActiveExecutions,
  stopAllProductSpaceExecutions,
} from '../product-space'

const accountId = 'account-a'
const productSpaceId = 'space-a'

function createMockSessionManager(
  sessions: Array<{
    id: string
    name?: string
    workspaceId: string
    isProcessing: boolean
    stopLatencyMs?: number
    refuseStop?: boolean
  }>,
) {
  const state = sessions.map(session => ({ ...session }))
  const sessionManager = {
    getSessions: () => state.map(session => ({
      id: session.id,
      name: session.name,
      workspaceId: session.workspaceId,
      isProcessing: session.isProcessing,
    })),
    cancelProcessing: async (sessionId: string) => {
      const session = state.find(candidate => candidate.id === sessionId)
      if (!session) return
      if (session.refuseStop) throw new Error('cancel channel broken')
      if (!session.isProcessing) return
      if (session.stopLatencyMs) {
        await new Promise(resolve => setTimeout(resolve, session.stopLatencyMs))
      }
      session.isProcessing = false
    },
  }
  return {
    sessionManager: sessionManager as unknown as HandlerDeps['sessionManager'],
    state,
  }
}

beforeEach(() => {})

describe('listProductSpaceActiveExecutions', () => {
  it('lists only in-flight executions with the requested account/space tuple', () => {
    const { sessionManager } = createMockSessionManager([
      { id: 'exec-1', name: '访谈整理', workspaceId: 'ws-1', isProcessing: true },
      { id: 'exec-2', name: '已停止', workspaceId: 'ws-1', isProcessing: false },
      { id: 'exec-3', workspaceId: 'ws-2', isProcessing: true },
    ])
    const executions = listProductSpaceActiveExecutions({
      sessionManager,
      accountId,
      productSpaceId,
    })
    expect(executions.map(execution => execution.executionId as string))
      .toEqual(['exec-1', 'exec-3'])
    for (const execution of executions) {
      expect(execution.scope.accountId as string).toBe(accountId)
      expect(execution.scope.productSpaceId as string).toBe(productSpaceId)
      expect(execution.scope.workspaceId as string).not.toBe(productSpaceId)
      expect(execution.scope.subject).toEqual({
        kind: 'built_in_app',
        builtInAppId: 'polo_assistant',
      })
    }
  })

  it('returns no executions for a quiet runtime', () => {
    const { sessionManager } = createMockSessionManager([])
    const executions = listProductSpaceActiveExecutions({
      sessionManager,
      accountId,
      productSpaceId,
    })
    expect(executions).toEqual([])
  })
})

describe('stopAllProductSpaceExecutions', () => {
  it('stops multiple concurrent executions and reports each as stopped', async () => {
    const { sessionManager } = createMockSessionManager([
      { id: 'exec-1', name: 'A', workspaceId: 'ws-1', isProcessing: true, stopLatencyMs: 60 },
      { id: 'exec-2', name: 'B', workspaceId: 'ws-1', isProcessing: true },
      { id: 'exec-3', name: 'C', workspaceId: 'ws-2', isProcessing: true },
    ])
    const result = await stopAllProductSpaceExecutions({
      sessionManager,
      accountId,
      productSpaceId,
    })
    expect(result.allStopped).toBe(true)
    expect(result.executions.map(execution => execution.status))
      .toEqual(['stopped', 'stopped', 'stopped'])
    expect(sessionManager.getSessions().every(session => !session.isProcessing)).toBe(true)
  })

  it('reports a failure and keeps the execution non-terminal when a stop fails', async () => {
    const { sessionManager } = createMockSessionManager([
      { id: 'exec-1', name: 'A', workspaceId: 'ws-1', isProcessing: true },
      { id: 'exec-2', name: 'Stuck', workspaceId: 'ws-1', isProcessing: true, refuseStop: true },
    ])
    const result = await stopAllProductSpaceExecutions({
      sessionManager,
      accountId,
      productSpaceId,
    })
    expect(result.allStopped).toBe(true)
    const stuck = result.executions.find(execution => execution.executionId === 'exec-2')
    expect(stuck?.status).toBe('failed')
    expect(stuck?.errorCode).toBe('runtime_stop_failed')
    expect(result.executions.find(execution => execution.executionId === 'exec-1')?.status)
      .toBe('stopped')
  })
})
