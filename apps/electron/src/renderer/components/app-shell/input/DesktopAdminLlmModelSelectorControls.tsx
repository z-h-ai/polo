import type { LlmConnection } from '@config/llm-connections'
import { AdminLlmModelSelectorPanel } from './AdminLlmModelSelectorPanel'

interface DesktopAdminLlmModelSelectorControlsProps {
  llmConnections: LlmConnection[]
  currentConnection?: string
  currentModel: string
  onModelChange: (model: string, connection?: string) => void
  onConnectionChange?: (connectionSlug: string) => void
}

export function DesktopAdminLlmModelSelectorControls({
  llmConnections,
  currentConnection,
  currentModel,
  onModelChange,
  onConnectionChange,
}: DesktopAdminLlmModelSelectorControlsProps) {
  return (
    <AdminLlmModelSelectorPanel
      llmConnections={llmConnections}
      currentConnection={currentConnection}
      currentModel={currentModel}
      onConnectionChange={onConnectionChange}
      onModelChange={onModelChange}
    />
  )
}
