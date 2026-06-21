import type { LlmConnectionWithStatus } from '@config/llm-connections'

interface PersistModelSelectionOptions {
  connection: LlmConnectionWithStatus
  modelId: string
  refreshLlmConnections?: () => Promise<void>
}

export async function persistModelSelection({
  connection,
  modelId,
  refreshLlmConnections,
}: PersistModelSelectionOptions): Promise<boolean> {
  if (!connection.isAuthenticated) return false

  const defaultResult = await window.electronAPI.setDefaultLlmConnection(connection.slug)
  if (!defaultResult.success) {
    throw new Error(defaultResult.error || 'Failed to update default connection')
  }

  if (connection.defaultModel !== modelId) {
    const {
      isAuthenticated: _isAuthenticated,
      authError: _authError,
      isDefault: _isDefault,
      ...connectionToSave
    } = connection

    const saveResult = await window.electronAPI.saveLlmConnection({
      ...connectionToSave,
      defaultModel: modelId,
    })
    if (!saveResult.success) {
      throw new Error(saveResult.error || 'Failed to update default model')
    }
  }

  await refreshLlmConnections?.()
  return true
}
