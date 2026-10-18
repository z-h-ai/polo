/**
 * Session Tools Core
 *
 * Shared utilities for session-scoped tools used by both
 * Claude (in-process) and Pi (host-side proxy execution) implementations.
 *
 * @packageDocumentation
 */

// Types
export type {
  // Credential types
  CredentialInputMode,

  // Service types
  GoogleService,
  SlackService,
  MicrosoftService,

  // Auth request types
  AuthRequestType,
  BaseAuthRequest,
  CredentialAuthRequest,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  SlackOAuthAuthRequest,
  MicrosoftOAuthAuthRequest,
  AuthRequest,
  AuthResult,

  // IPC types

  // Tool result types
  TextContent,
  ToolResult,

  // Developer feedback
  DeveloperFeedback,

  // Validation types
  ValidationIssue,
  ValidationResult,

  // Source config types
  SourceType,
  McpTransport,
  McpAuthType,
  ApiAuthType,
  McpSourceConfig,
  ApiSourceConfig,
  LocalSourceConfig,
  SourceConfig,
  ConnectionStatus,
} from './types.ts';

// Response helpers
export {
  successResponse,
  errorResponse,
  textContent,
  multiBlockResponse,
} from './response.ts';

// Source helpers
export {
  getSourcePath,
  getSourceConfigPath,
  getSourceGuidePath,
  sourceExists,
  sourceConfigExists,
  loadSourceConfig,
  listSourceSlugs,
  getSkillPath,
  getSkillMdPath,
  skillExists,
  skillMdExists,
  listSkillSlugs,
  generateRequestId,
  // Multi-header credential helpers
  detectCredentialMode,
  getEffectiveHeaderNames,
} from './source-helpers.ts';

// Validation
export {
  // Result helpers
  validResult,
  invalidResult,
  mergeResults,

  // Formatting
  formatValidationResult,

  // JSON utilities
  readJsonFile,
  validateJsonFileHasFields,
  zodErrorToIssues,

  // Slug validation
  SLUG_REGEX,
  validateSlug,

  // Skill validation
  SkillMetadataSchema,
  validateSkillContent,

  // Source validation
  SOURCE_CONFIG_REQUIRED_FIELDS,
  SOURCE_TYPES,
  validateSourceConfigBasic,
} from './validation.ts';

// Question request protocol (request_user_input)
export {
  REQUEST_USER_INPUT_OTHER_OPTION_ID,
  REQUEST_USER_INPUT_ID_PATTERN,
  REQUEST_USER_INPUT_MAX_QUESTIONS,
  REQUEST_USER_INPUT_MIN_OPTIONS,
  REQUEST_USER_INPUT_MAX_OPTIONS,
  REQUEST_USER_INPUT_MAX_OTHER_TEXT,
  RequestUserInputOptionSchema,
  RequestUserInputQuestionSchema,
  RequestUserInputArgsSchema,
  validateRequestUserInputArgs,
  parseRequestUserInputArgs,
} from './question-types.ts';

export type {
  RequestUserInputOptionArgs,
  RequestUserInputQuestionArgs,
  RequestUserInputArgs,
} from './question-types.ts';

// Session MCP server spawn spec (dependency-free leaf — see spawn-spec.ts)
export { buildSessionMcpServerArgs } from './spawn-spec.ts';
export type { SessionMcpSpawnOptions } from './spawn-spec.ts';

// Context interface
export type {
  SessionToolContext,
  SessionToolCallbacks,
  FileSystemInterface,
  CredentialManagerInterface,
  ValidatorInterface,
  LoadedSource,
  // MCP validation types
  StdioMcpConfig,
  HttpMcpConfig,
  StdioValidationResult,
  McpValidationResult,
  ApiTestResult,
  // Session self-management types
  SessionInfo,
  SessionListItem,
  ListSessionsOptions,
  ListSessionsResult,
  ResolvedLabelsResult,
  ResolvedStatusResult,
} from './context.ts';

export { createNodeFileSystem } from './context.ts';

// Runtime-scoped subprocess environment policy
export {
  BLOCKED_ENV_VARS,
  TOOL_ENV_ALLOWLIST,
  TOOL_ENV_ALLOWLIST_NAMES,
  TOOL_ENV_ALLOWLIST_SHELL_PATTERN,
  createSanitizedEnv,
  createScriptRuntimeEnv,
  isToolEnvironmentVariableAllowed,
} from './runtime/sandbox-env.ts';

// Handlers
export {
  // SubmitPlan
  handleSubmitPlan,
  // Config Validate
  handleConfigValidate,
  // Skill Validate
  handleSkillValidate,
  // Mermaid Validate
  handleMermaidValidate,
  // Source Test
  handleSourceTest,
  // OAuth Triggers
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
  // Credential Prompt
  handleCredentialPrompt,
  // Request User Input
  handleRequestUserInput,
  // Update Preferences
  handleUpdatePreferences,
  // Transform Data
  handleTransformData,
  // Script Sandbox
  handleScriptSandbox,
  // Render Template
  handleRenderTemplate,
  // Render UI (Generative UI inline cards)
  handleRenderUi,
  // Send Developer Feedback
  handleSendDeveloperFeedback,
} from './handlers/index.ts';

export type {
  SubmitPlanArgs,
  ConfigValidateArgs,
  SkillValidateArgs,
  MermaidValidateArgs,
  SourceTestArgs,
  SourceOAuthTriggerArgs,
  GoogleOAuthTriggerArgs,
  SlackOAuthTriggerArgs,
  MicrosoftOAuthTriggerArgs,
  CredentialPromptArgs,
  UpdatePreferencesArgs,
  TransformDataArgs,
  ScriptSandboxArgs,
  RenderTemplateArgs,
  RenderUiArgs,
  SendDeveloperFeedbackArgs,
} from './handlers/index.ts';

// Tool definitions — single source of truth
export {
  // Individual Zod schemas
  SubmitPlanSchema,
  ConfigValidateSchema,
  SkillValidateSchema,
  MermaidValidateSchema,
  SourceTestSchema,
  SourceOAuthTriggerSchema,
  CredentialPromptSchema,
  CallLlmSchema,
  UpdatePreferencesSchema,
  TransformDataSchema,
  ScriptSandboxSchema,
  RenderTemplateSchema,
  // Generative UI (render_ui) schemas
  GenUIStatCardSchema,
  GenUIDataTableSchema,
  GenUIAlertSchema,
  GenUIProgressSchema,
  GenUIActionButtonsWithIdSchema,
  GenUIComponentSchema,
  RenderUiSchema,
  RENDER_UI_MAX_PAYLOAD_BYTES,
  RENDER_UI_MAX_COMPONENTS,
  // Browser tool schema
  BrowserToolSchema,
  // Developer feedback schema
  SendDeveloperFeedbackSchema,
  // Descriptions
  TOOL_DESCRIPTIONS,
  // Registry
  SESSION_TOOL_DEFS,
  SESSION_TOOL_NAMES,
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_REGISTRY_TOOL_NAMES,
  SESSION_SAFE_ALLOWED_TOOL_NAMES,
  SESSION_SAFE_BLOCKED_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  // Filtered helper views
  getSessionToolDefs,
  getSessionToolNames,
  getSessionBackendToolNames,
  getSessionRegistryToolNames,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  getSessionSafeBlockedToolNames,
  // JSON Schema converter
  getToolDefsAsJsonSchema,
} from './tool-defs.ts';

// POO-104 GenUI component catalog seam (§5.7): model-side index, dynamic
// render_ui union assembly, and replay schemaVersion snapshots.
export {
  GENUI_RENDER_UI_SCHEMA_VERSION,
  GENUI_BUILTIN_COMPONENT_DESCRIPTORS,
  sanitizeCatalogText,
  buildRenderUiCatalogSection,
  buildRenderUiToolDescription,
} from './genui-catalog.ts';
export type { GenUiComponentDescriptor } from './genui-catalog.ts';
export {
  GENUI_COMPONENT_SCHEMAS,
  buildRenderUiSchemaForComponentTypes,
  buildRenderUiJsonSchemaForComponentTypes,
  getGenUiComponentJsonSchemas,
  getGenUiComponentSchemasForSnapshot,
  validateGenUiComponentsForSnapshot,
  assertBuiltinCatalogConsistency,
  GenUiSnapshotValidationError,
} from './genui-schema.ts';

export type {
  SessionToolExecutionMode,
  SessionToolSafeMode,
  SessionToolDef,
  RegistrySessionToolDef,
  BackendSessionToolDef,
  SessionToolHandler,
  JsonSchemaToolDef,
  SessionToolFilterOptions,
  SessionToolNameOptions,
  GenUIComponent,
} from './tool-defs.ts';
