import type { PermissionRequest, CredentialRequest, CredentialResponse, QuestionRequest, QuestionResponse } from '../../../../../shared/types'
import type { AdminApprovalRequestData } from './AdminApprovalRequest'

/**
 * Input mode determines which component is rendered in InputContainer
 */
export type InputMode = 'freeform' | 'structured'

/**
 * Types of structured input UIs
 */
export type StructuredInputType = 'permission' | 'credential' | 'admin_approval' | 'question'

/**
 * Union type for structured input data
 */
export type StructuredInputData =
  | { type: 'permission'; data: PermissionRequest }
  | { type: 'credential'; data: CredentialRequest }
  | { type: 'admin_approval'; data: AdminApprovalRequestData }
  | { type: 'question'; data: QuestionRequest }

/**
 * State for structured input
 */
export interface StructuredInputState {
  type: StructuredInputType
  data: PermissionRequest | CredentialRequest | AdminApprovalRequestData | QuestionRequest
}

/**
 * Response from permission request
 */
export interface PermissionResponse {
  type: 'permission'
  allowed: boolean
  alwaysAllow: boolean
}

/**
 * Response from admin approval request
 */
export interface AdminApprovalResponse {
  type: 'admin_approval'
  approved: boolean
  rememberForMinutes?: number
}

/**
 * Response from a question request (agent asked, user answered)
 */
export interface QuestionInputResponse {
  type: 'question'
  response: QuestionResponse
}

/**
 * Cancel action for a question request ("skip for now")
 */
export interface QuestionCancelResponse {
  type: 'question_cancel'
  requestId: string
}

/**
 * Union type for all structured responses
 */
export type StructuredResponse = PermissionResponse | CredentialResponse | AdminApprovalResponse | QuestionInputResponse | QuestionCancelResponse

// Re-export CredentialResponse for convenience
export type { CredentialResponse }
