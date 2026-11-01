import { expect, it, mock } from 'bun:test'
const host = { webContents: { id: 71 }, isDestroyed: () => false }
mock.module('electron', () => ({ BrowserWindow: { getAllWindows: () => [host] } }))
mock.module('@polo-ai/server-core/transport', () => ({ pushTyped() {} }))
mock.module('../handlers/genui', () => ({ resolveTrustedSessionContext: () => ({ dataPath: '/owned/data' }) }))
const { registerCanvasPaneHandlers } = await import('../handlers/canvas')
const { RPC_CHANNELS } = await import('../../shared/types')
it('EMBED RPC propagates the asynchronous carrier load rejection to its caller', async () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const embed = mock(async () => { throw new Error('carrier load rejected') })
  registerCanvasPaneHandlers({ handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, {
    canvasPopupManager: { embed, onStateChanged() {} }, windowManager: { getWorkspaceForWindow: () => 'ws-a' },
  } as any)
  await expect(handlers.get(RPC_CHANNELS.canvasPane.EMBED)!({ webContentsId: 71, workspaceId: 'ws-a' }, 'sess-a', { appId: 'guide', title: 'Guide', indexPath: '/owned/data/genui-apps/guide/index.html' }, { x: 0, y: 0, width: 400, height: 700 })).rejects.toThrow('carrier load rejected')
  expect(embed).toHaveBeenCalledTimes(1)
})
