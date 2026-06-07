import * as React from 'react'
import {
  ANTHROPIC_MODELS,
  getModelDisplayName,
} from '@config/models'
import type { LlmConnection } from '@config/llm-connections'
import { NoLlmConfigBanner } from '@/components/NoLlmConfigBanner'
import { stripPiPrefixForDisplay } from './model-picker-helpers'

interface AdminLlmModelSelectorPanelProps {
  llmConnections: LlmConnection[]
  currentConnection?: string
  currentModel: string
  onModelChange: (model: string, connection?: string) => void
  onConnectionChange?: (connectionSlug: string) => void
}

interface ResolveAdminModelSelectionInput {
  llmConnections: LlmConnection[]
  targetConnectionSlug: string
  targetModel?: string
  currentConnectionSlug?: string
  currentModel: string
  onModelChange: (model: string, connection?: string) => void
  onConnectionChange?: (connectionSlug: string) => void
}

function modelId(model: string | { id: string }) {
  return typeof model === 'string' ? model : model.id
}

function modelLabel(model: string | { id: string; name?: string }) {
  return typeof model === 'string'
    ? stripPiPrefixForDisplay(getModelDisplayName(model))
    : (model.name ?? stripPiPrefixForDisplay(model.id))
}

function getConnectionModelIds(connection: LlmConnection | null): string[] {
  if (!connection) return []
  return (connection.models ?? ANTHROPIC_MODELS).map(modelId)
}

function resolveSelectedConnection(
  llmConnections: LlmConnection[],
  currentConnection?: string,
): LlmConnection | null {
  return (
    llmConnections.find(c => c.slug === currentConnection)
    ?? llmConnections[0]
    ?? null
  )
}

function resolveSelectedModel(connection: LlmConnection | null, currentModel: string) {
  const ids = getConnectionModelIds(connection)
  if (currentModel && ids.includes(currentModel)) return currentModel
  if (connection?.defaultModel && ids.includes(connection.defaultModel)) {
    return connection.defaultModel
  }
  return ids[0] ?? currentModel
}

export function resolveAdminModelSelection({
  llmConnections,
  targetConnectionSlug,
  targetModel,
  currentConnectionSlug,
  currentModel,
  onConnectionChange,
  onModelChange,
}: ResolveAdminModelSelectionInput) {
  const connection = llmConnections.find(c => c.slug === targetConnectionSlug)
  if (!connection) return

  const model = targetModel ?? resolveSelectedModel(connection, currentModel)
  if (targetConnectionSlug !== currentConnectionSlug) {
    onConnectionChange?.(targetConnectionSlug)
  }
  onModelChange(model, targetConnectionSlug)
}

export function AdminLlmModelSelectorPanel({
  llmConnections,
  currentConnection,
  currentModel,
  onModelChange,
  onConnectionChange,
}: AdminLlmModelSelectorPanelProps) {
  const selectedConnection = resolveSelectedConnection(llmConnections, currentConnection)

  if (!selectedConnection) {
    return <NoLlmConfigBanner />
  }

  const selectedModel = resolveSelectedModel(selectedConnection, currentModel)
  const selectedModels = selectedConnection.models ?? ANTHROPIC_MODELS

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {llmConnections.length > 1 && (
        <select
          aria-label="LLM 连接"
          value={selectedConnection.slug}
          onChange={(event) => {
            resolveAdminModelSelection({
              llmConnections,
              targetConnectionSlug: event.currentTarget.value,
              currentConnectionSlug: selectedConnection.slug,
              currentModel,
              onConnectionChange,
              onModelChange,
            })
          }}
          className="h-9 rounded-md border border-foreground/15 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-foreground/30"
        >
          {llmConnections.map(connection => (
            <option key={connection.slug} value={connection.slug}>
              {connection.name}
            </option>
          ))}
        </select>
      )}

      <select
        aria-label="LLM 模型"
        value={selectedModel}
        onChange={(event) => {
          resolveAdminModelSelection({
            llmConnections,
            targetConnectionSlug: selectedConnection.slug,
            targetModel: event.currentTarget.value,
            currentConnectionSlug: selectedConnection.slug,
            currentModel,
            onConnectionChange,
            onModelChange,
          })
        }}
        className="h-9 rounded-md border border-foreground/15 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-foreground/30"
      >
        {selectedModels.map(model => {
          const id = modelId(model)
          return (
            <option key={id} value={id}>
              {modelLabel(model)}
            </option>
          )
        })}
      </select>
    </div>
  )
}
