import { app } from 'electron'
import { createSessionlessHostLlmExecutor } from '@polo-ai/shared/agent/host-llm-executor'

/** App execution uses the same shipped Pi worker and Node resolver as sessions. */
export function createElectronAppLlmExecutor(
  options: Parameters<typeof createSessionlessHostLlmExecutor>[0],
) {
  return createSessionlessHostLlmExecutor({
    ...options,
    hostRuntime: {
      appRootPath: app.isPackaged ? app.getAppPath() : process.cwd(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    },
  })
}
