// Main components
export { InputContainer } from './InputContainer'
export { ChatInputZone } from './ChatInputZone'
export type { ChatInputStatusBanner } from './ChatInputZone'
export { FreeFormInput } from './FreeFormInput'
export { StructuredInput } from './StructuredInput'

// Structured input components
export { PermissionRequest } from './structured/PermissionRequest'
export { QuestionRequest } from './structured/QuestionRequest'

// Hooks
export { useAutoGrow } from './useAutoGrow'

// Types
export type {
  InputMode,
  StructuredInputType,
  StructuredInputState,
  StructuredInputData,
  StructuredResponse,
  PermissionResponse,
  AdminApprovalResponse,
  QuestionInputResponse,
  QuestionCancelResponse,
} from './structured/types'
