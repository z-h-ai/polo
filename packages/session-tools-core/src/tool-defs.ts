/**
 * Session Tool Definitions — Single Source of Truth
 *
 * Canonical Zod schemas, descriptions, and handler registry for all
 * session-scoped tools. Consumers derive what they need:
 *
 * - Claude SDK  → `.shape` extracts the plain `{ key: z.string() }` literal
 * - MCP / Pi    → `getToolDefsAsJsonSchema()` auto-converts to JSON Schema
 *
 * Adding a new tool: define the schema, description, handler import, and
 * one entry in SESSION_TOOL_DEFS.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { SessionToolContext } from './context.ts';
import type { ToolResult } from './types.ts';
// POO-104 model-side component index (§5.7): one-way import — genui-catalog
// stays dependency-free so the dynamic schema assembly (genui-schema.ts) can
// import both sides without a cycle.
import { GENUI_BUILTIN_COMPONENT_DESCRIPTORS, buildRenderUiToolDescription, type GenUiComponentDescriptor } from './genui-catalog.ts';

// Handlers
import { handleSubmitPlan } from './handlers/submit-plan.ts';
import { handleConfigValidate } from './handlers/config-validate.ts';
import { handleSkillValidate } from './handlers/skill-validate.ts';
import { handleMermaidValidate } from './handlers/mermaid-validate.ts';
import { handleGenerateApp } from './handlers/generate-app.ts';
import { handleSourceTest } from './handlers/source-test.ts';
import {
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
} from './handlers/source-oauth.ts';
import { handleCredentialPrompt } from './handlers/credential-prompt.ts';
import { handleRequestUserInput } from './handlers/request-user-input.ts';
import { RequestUserInputArgsSchema, REQUEST_USER_INPUT_OTHER_OPTION_ID } from './question-types.ts';
import { handleUpdatePreferences } from './handlers/update-preferences.ts';
import { handleTransformData } from './handlers/transform-data.ts';
import { handleRenderUi } from './handlers/render-ui.ts';
import { handleScriptSandbox } from './handlers/script-sandbox.ts';
import { handleRenderTemplate } from './handlers/render-template.ts';
import { handleSendDeveloperFeedback } from './handlers/send-developer-feedback.ts';
import { handleSetSessionLabels } from './handlers/set-session-labels.ts';
import { handleSetSessionStatus } from './handlers/set-session-status.ts';
import { handleGetSessionInfo } from './handlers/get-session-info.ts';
import { handleListSessions } from './handlers/list-sessions.ts';
import { handleSendAgentMessage } from './handlers/send-agent-message.ts';
import { handleListMessagingChannels, handleUnbindMessagingChannel } from './handlers/messaging.ts';

// ============================================================
// Canonical Zod Schemas
// ============================================================

export const SubmitPlanSchema = z.object({
  planPath: z.string().describe('Absolute path to the plan markdown file you wrote'),
});

export const ConfigValidateSchema = z.object({
  target: z.enum(['config', 'sources', 'statuses', 'preferences', 'permissions', 'automations', 'tool-icons', 'all'])
    .describe('Which config file(s) to validate'),
  sourceSlug: z.string().optional().describe('Validate a specific source by slug'),
});

export const SkillValidateSchema = z.object({
  skillSlug: z.string().describe('The slug of the skill to validate'),
});

export const MermaidValidateSchema = z.object({
  code: z.string().describe('The mermaid diagram code to validate'),
  render: z.boolean().optional().describe('Also attempt to render (catches layout errors)'),
});

export const SourceTestSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to test'),
  autoEnable: z
    .boolean()
    .optional()
    .describe(
      'Automatically enable and activate the source in the current session on successful validation. Defaults to true. Pass false to keep pure validation behavior.'
    ),
});

export const SourceOAuthTriggerSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
});

export const CredentialPromptSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
  mode: z.enum(['bearer', 'basic', 'header', 'query', 'multi-header']).describe('Type of credential input'),
  labels: z.object({
    credential: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional().describe('Custom field labels'),
  description: z.string().optional().describe('Description shown to user'),
  hint: z.string().optional().describe('Hint about where to find credentials'),
  headerNames: z.array(z.string()).optional().describe('Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])'),
  passwordRequired: z.boolean().optional().describe('For basic auth: whether password is required'),
});

// Re-export the canonical request_user_input schema so consumers can import
// everything tool-related from this module.
export { RequestUserInputArgsSchema } from './question-types.ts';

export const CallLlmSchema = z.object({
  prompt: z.string().describe('Instructions for the LLM'),
  attachments: z.array(z.union([
    z.string().describe('Simple file path'),
    z.object({
      path: z.string().describe('File path'),
      startLine: z.number().optional().describe('First line (1-indexed)'),
      endLine: z.number().optional().describe('Last line (1-indexed)'),
    }),
  ])).optional().describe('File paths on disk to attach (max 20). NOT for inline text — put text in prompt instead. Use {path, startLine, endLine} for large files.'),
  model: z.string().optional().describe('Model ID or short name. Defaults to a fast model.'),
  systemPrompt: z.string().optional().describe('Optional system prompt'),
  maxTokens: z.number().optional().describe('Max output tokens (1-64000). Defaults to 4096'),
  temperature: z.number().optional().describe('Sampling temperature 0-1'),
  thinking: z.boolean().optional().describe('Enable extended thinking. Incompatible with outputFormat/outputSchema'),
  thinkingBudget: z.number().optional().describe('Token budget for thinking (1024-100000). Defaults to 10000'),
  outputFormat: z.enum(['summary', 'classification', 'extraction', 'analysis', 'comparison', 'validation']).optional()
    .describe('Predefined output format'),
  outputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
  }).optional().describe('Custom JSON Schema for structured output'),
});

export const UpdatePreferencesSchema = z.object({
  name: z.string().optional().describe("The user's preferred name or how they'd like to be addressed"),
  timezone: z.string().optional().describe("The user's timezone in IANA format (e.g., 'America/New_York', 'Europe/London')"),
  city: z.string().optional().describe("The user's city"),
  region: z.string().optional().describe("The user's state/region/province"),
  country: z.string().optional().describe("The user's country"),
  language: z.string().optional().describe("The user's preferred language for responses"),
  notes: z.string().optional().describe('Additional notes about the user that would be helpful to remember (preferences, context, etc.). Replaces any existing notes.'),
  includeCoAuthoredBy: z.boolean().optional().describe("Whether to include 'Co-Authored-By: Polo AI' trailer on git commits. Defaults to true."),
});

export const TransformDataSchema = z.object({
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Transform script source code. Receives input file paths as command-line args (sys.argv[1:] or process.argv.slice(2)), last arg is the output file path.'),
  inputFiles: z.array(z.string()).describe('Input file paths relative to session dir (e.g., "long_responses/stripe_txns.txt")'),
  outputFile: z.string().describe('Output file name relative to session data/ dir (e.g., "transactions.json")'),
});

// ============================================================
// render_ui — Generative UI (Track 1, declarative, no code exec)
// ============================================================

/** Hard cap on the whole render_ui input, serialized as UTF-8 JSON. */
export const RENDER_UI_MAX_PAYLOAD_BYTES = 4096;
/** Max components per render_ui call. */
export const RENDER_UI_MAX_COMPONENTS = 8;

/**
 * P1-1 schema slimming: usage-level field semantics live in ONE place — the
 * render_ui base description (**Value semantics**) and the component catalog
 * one-liners (genui-catalog.ts) — not in `.describe()` here. Describes that
 * remain are structure-adjacent contracts the one-liners cannot hold (the
 * 160-char catalog cap): id/placeholder interpolation, delta decimal format,
 * the link value form. Non-functional string-length caps were stripped from
 * the zod schema (wire + runtime) EXCEPT the ones behavior tests pin as
 * validation contracts (chart label/name/unit, rowAction label/template
 * bounds, stat-card currency, confirm message, param key/label) — the
 * execution-time Zod pass (render-ui handler) still enforces everything
 * that remains.
 */
const GenUIBase = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
});

export const GenUIStatCardSchema = GenUIBase.extend({
  type: z.literal('stat-card'),
  label: z.string(),
  value: z.union([z.number(), z.string()]),
  format: z.enum(['number', 'percent', 'currency']).optional(),
  currency: z.string().max(8).optional()
    .describe("Currency symbol or code used by format 'currency' (e.g. '$', 'CNY')."),
  unit: z.string().optional(),
  delta: z.number().optional().describe('Decimal, e.g. 0.152 = +15.2%'),
  trend: z.enum(['up', 'down', 'flat']).optional(),
  goodWhen: z.enum(['up', 'down', 'neutral']).default('up'),
});

// Column types align with the datatable rich-block contract in system.ts
const GenUITableColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'currency', 'percent', 'boolean', 'date', 'badge']).default('text'),
  // Percent-column rendering semantics (rate/share vs change) are documented
  // in the tool description's **Value semantics** section, not here.
  semantics: z.enum(['rate', 'share', 'change']).default('change'),
  badgeColors: z.record(z.string(), z.enum(['info', 'success', 'warning', 'error'])).optional(),
  // Source link (iter/row-actions): the value renders as a link and opens via
  // the platform URL handler — e.g. a clause number whose original text lives
  // at a URL the model puts in the data. href comes from the row value itself
  // (when it is an http(s) URL) or its { value, link } object form.
  link: z.boolean().optional()
    .describe('Values render as external links; the row value is the URL itself or an object { value, link }.')
});

export const GenUIDataTableSchema = GenUIBase.extend({
  type: z.literal('data-table'),
  columns: z.array(GenUITableColumnSchema).min(1).max(24),
  // Hard rule: inline rows are NOT accepted — data must land on disk via
  // transform_data first, then be referenced through "src". The catalog
  // one-liner carries that contract to the model; validation errors repeat it.
  src: z.string().min(1),
  pageSize: z.number().int().min(5).max(100).optional(),
  // Row-level actions (iter/row-actions) — all optional; a table without them
  // renders exactly like before. Placeholders {{col.key}} are filled from the
  // clicked row's values; missing values become empty strings. The label /
  // template length caps stay: tests pin them as validation contracts.
  rowAction: z.object({
    label: z.string().max(20),
    promptTemplate: z.string().max(500)
      .describe("Sent as the next user message when the row's action button is clicked; {{col.key}} is replaced by that row's values."),
  }).strict().optional(),
  detailTemplate: z.string().max(500).optional()
    .describe('Per-row Details: fills {{col.key}} from the row and prefills the chat input without sending.'),
  // Rejecting unknown keys here is what enforces "no inline rows": a `rows`
  // field fails validation with a clear message instead of being stripped.
}).strict();

/**
 * chart (iter/chart): the sixth component, a CLOSED FORM — exactly four chart
 * types, 2-24 categories, 1-3 bounded series, everything optional except the
 * shape itself. Unlike data-table there is no `src`: chart payloads are
 * inline by design (few points), with the array-level superRefine's 4KB cap
 * as the natural backstop. `.strict()` rejects unknown keys so a future
 * escape hatch cannot grow silently; the categories/values equal-length rule
 * lives on the components array superRefine (a refine here would wrap this
 * member in ZodEffects and break the discriminated union — same constraint
 * as the button params rule).
 */
export const GenUIChartSchema = GenUIBase.extend({
  type: z.literal('chart'),
  // chartType selection guidance lives in the catalog one-liner; the closed
  // enum is the structure. Label/name/unit caps stay: tests pin them.
  chartType: z.enum(['bar', 'line', 'funnel', 'pie']),
  categories: z.array(z.string().max(60)).min(2).max(24)
    .describe('X-axis labels / funnel stages / pie slice names.'),
  series: z.array(z.object({
    name: z.string().max(60),
    unit: z.string().max(12).optional(),
    values: z.array(z.number()).min(2).max(48)
      .describe('One number per category, same order.'),
  })).min(1).max(3)
    .describe('pie/funnel render the first series only.'),
  goodWhen: z.enum(['up', 'down', 'neutral']).optional()
    .describe('Reserved; not rendered yet.'),
}).strict();

export const GenUIAlertSchema = GenUIBase.extend({
  type: z.literal('alert'),
  severity: z.enum(['info', 'success', 'warning', 'error']),
  message: z.string(),
});

export const GenUIProgressSchema = GenUIBase.extend({
  type: z.literal('progress'),
  status: z.enum(['running', 'success', 'error']),
  label: z.string(),
  percent: z.number().min(0).max(100).optional().describe('Omit for indeterminate'),
});

/** One per-click parameter field the user fills before the action runs. */
const GenUIActionButtonParamSchema = z.object({
  // key/label caps stay: tool-defs-genui-action-buttons pins them (40/60).
  key: z.string().max(40),
  label: z.string().max(60),
  type: z.enum(['text', 'number', 'select']).default('text'),
  required: z.boolean().default(false),
  // Same convention as form fields: only select params may carry options, and
  // a select param must — enforced by the button-level superRefine below.
  options: z.array(z.string()).max(12).optional(),
});

const GenUIActionButtonSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  style: z.enum(['primary', 'secondary', 'danger']).default('secondary'),
  // Optional pre-click gates (all UI-only — the backfill pipeline itself is
  // unchanged). confirm renders an in-place confirmation bar before the
  // action fires; params renders an in-place mini form whose values are
  // interpolated into promptTemplate.
  confirm: z.object({
    // The 300-char cap stays: tool-defs-genui-action-buttons pins it.
    message: z.string().max(300)
      .describe('Shown on the in-place confirmation bar before the action runs — state the consequence.'),
  }).optional(),
  params: z.array(GenUIActionButtonParamSchema).max(8).optional(),
  // P0 only ships these two backfill actions; run-tool direct invocation is
  // deferred to P2 (needs the capability gating work).
  action: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('send-message'),
      prompt: z.string().min(1)
        .describe('Sent as the next user message when clicked.')
        .optional(),
      promptTemplate: z.string().min(1)
        .describe('Sent as the next user message when clicked; every {{key}} is replaced by the value the user entered in the params form. Required when params is set.')
        .optional(),
    }),
    z.object({
      kind: z.literal('fill-input'),
      text: z.string().min(1)
        .describe('Prefills the chat input without sending'),
    }),
  ]),
}).superRefine((button, ctx) => {
  // Cross-field rules that cannot live on the discriminated union members
  // (a refine would wrap them in ZodEffects and break the union) — same
  // constraint that keeps the form rules on the components array.
  const action = button.action;
  if (action.kind === 'send-message') {
    if (action.prompt && action.promptTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'promptTemplate'],
        message: 'send-message actions must use either "prompt" or "promptTemplate", not both.',
      });
    }
    if (!action.prompt && !action.promptTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'prompt'],
        message: 'send-message actions require "prompt" or "promptTemplate".',
      });
    }
  }
  if (!button.params) return;
  // Parameterized buttons interpolate user input into a template — fill-input
  // has no template to interpolate into, so params require promptTemplate.
  if (action.kind !== 'send-message' || !action.promptTemplate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['params'],
      message: 'buttons with "params" must use a send-message action with "promptTemplate" ({{key}} placeholders).',
    });
  }
  // Mirror the form field contract: unique keys, select⇔options.
  const keys = new Set<string>();
  button.params.forEach((param, index) => {
    if (keys.has(param.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['params', index, 'key'],
        message: `Duplicate param key "${param.key}". Param keys must be unique within one button.`,
      });
    }
    keys.add(param.key);
    if (param.type === 'select' && (!param.options || param.options.length < 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['params', index, 'options'],
        message: `select param "${param.key}" requires at least one option.`,
      });
    }
    if (param.type !== 'select' && param.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['params', index, 'options'],
        message: `options are only valid on select params (param "${param.key}").`,
      });
    }
  });
});

export const GenUIActionButtonsWithIdSchema = GenUIBase.extend({
  type: z.literal('action-buttons'),
  buttons: z.array(GenUIActionButtonSchema).min(1).max(6),
});

/** One form field (POO-103): text/number/select/date inputs the user fills. */
const GenUIFormFieldSchema = z.object({
  key: z.string().min(1)
    .describe('Value key in the submitted JSON object'),
  label: z.string().min(1),
  type: z.enum(['text', 'number', 'select', 'date']).default('text'),
  required: z.boolean().optional(),
  // Only meaningful on select fields — the cross-field rule (select needs
  // options, others must not carry them) lives on the components array
  // superRefine, like every other cross-field rule.
  options: z.array(z.string().min(1)).min(1).max(20).optional(),
});

export const GenUIFormSchema = GenUIBase.extend({
  type: z.literal('form'),
  fields: z.array(GenUIFormFieldSchema).min(1).max(12),
  submitLabel: z.string().min(1).optional(),
  // NOTE: no "action" field on purpose — form submit is FIXED send-message
  // semantics (the serialized values object becomes the next user message).
  // Unknown keys are rejected, so an "action" attempt fails validation.
}).strict();

export const GenUIComponentSchema = z.discriminatedUnion('type', [
  GenUIStatCardSchema,
  GenUIDataTableSchema,
  GenUIAlertSchema,
  GenUIProgressSchema,
  GenUIActionButtonsWithIdSchema,
  GenUIFormSchema,
  GenUIChartSchema,
]);

/**
 * Per-member inference, not `z.infer` of the whole union: with a third
 * `.default()` field in the union the full-union instantiation exceeds TS's
 * depth budget and every consumer sees `{}` for the component type (it
 * silently degraded render-ui.ts and the schema tests to `unknown`). Members
 * infer fine individually, and the assembled array schema below pins this
 * type with a cast — runtime validation is untouched.
 */
export type GenUIComponent =
  | z.infer<typeof GenUIStatCardSchema>
  | z.infer<typeof GenUIDataTableSchema>
  | z.infer<typeof GenUIAlertSchema>
  | z.infer<typeof GenUIProgressSchema>
  | z.infer<typeof GenUIActionButtonsWithIdSchema>
  | z.infer<typeof GenUIFormSchema>
  | z.infer<typeof GenUIChartSchema>;

/** Pre-validation counterpart of GenUIComponent — the `.default()` fields (`goodWhen`, `semantics`, column `type`) are still optional. */
export type GenUIComponentInput =
  | z.input<typeof GenUIStatCardSchema>
  | z.input<typeof GenUIDataTableSchema>
  | z.input<typeof GenUIAlertSchema>
  | z.input<typeof GenUIProgressSchema>
  | z.input<typeof GenUIActionButtonsWithIdSchema>
  | z.input<typeof GenUIFormSchema>
  | z.input<typeof GenUIChartSchema>;

/**
 * Loose view of a component for the cross-field rules — the dynamic schema
 * assembly (genui-schema.ts) reuses this builder with unions that contain
 * only a subset of the component types, so the rules cannot assume the
 * static discriminated-union narrowing.
 */
type GenUiComponentLike = {
  id: string;
  type: string;
  fields?: Array<{ key: string; type: string; options?: string[] }>;
  categories?: unknown;
  series?: Array<{ values?: unknown }>;
};

/**
 * The components array with its cross-field rules, parameterized by the
 * component union. Cross-field rules live on the array (not the top-level
 * object): a superRefine on the object itself would wrap the schema in
 * ZodEffects and break the `.shape` access the Claude SDK toolset builder
 * relies on. The rules apply identically to every enabled-component subset
 * (POO-104 dynamic assembly) — payload cap, unique ids, and the form
 * select⇔options contract are union-independent.
 */
export function buildGenUiComponentsArraySchema(componentSchema: z.ZodTypeAny) {
  return z.array(componentSchema)
    .min(1)
    .max(RENDER_UI_MAX_COMPONENTS)
    .superRefine((components, ctx) => {
      // TextEncoder (not Buffer) so the schema stays portable to browser bundles.
      const bytes = new TextEncoder().encode(JSON.stringify({ components })).length;
      if (bytes > RENDER_UI_MAX_PAYLOAD_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Payload ${bytes}B exceeds ${RENDER_UI_MAX_PAYLOAD_BYTES}B. Move data into a file via transform_data and use "src".`,
        });
      }
      const ids = new Set<string>();
      (components as GenUiComponentLike[]).forEach((component, index) => {
        if (ids.has(component.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'id'],
            message: `Duplicate component id "${component.id}". Component ids must be unique within one call.`,
          });
        }
        ids.add(component.id);
        // form (POO-103) cross-field rules: unique keys; select fields need
        // options, non-select fields must not carry them.
        if (component.type === 'form' && Array.isArray(component.fields)) {
          const keys = new Set<string>();
          component.fields.forEach((field, fieldIndex) => {
            if (keys.has(field.key)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [index, 'fields', fieldIndex, 'key'],
                message: `Duplicate field key "${field.key}". Field keys must be unique within one form.`,
              });
            }
            keys.add(field.key);
            if (field.type === 'select' && (!field.options || field.options.length < 1)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [index, 'fields', fieldIndex, 'options'],
                message: `select field "${field.key}" requires at least one option.`,
              });
            }
            if (field.type !== 'select' && field.options) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [index, 'fields', fieldIndex, 'options'],
                message: `options are only valid on select fields (field "${field.key}").`,
              });
            }
          });
        }
        // chart (iter/chart) cross-field rule: every series must carry exactly
        // one value per category, in category order. Lives on the array like
        // the form rules — a superRefine on the chart member itself would
        // wrap it in ZodEffects and break the discriminated union. Guarded
        // with Array.isArray because the loose component view cannot assume
        // the chart member parsed (the per-field constraints already ran);
        // the narrowed arrays are bound to consts because narrowing does not
        // survive into the forEach callback.
        if (component.type === 'chart' && Array.isArray(component.categories) && Array.isArray(component.series)) {
          const categoryCount = component.categories.length;
          component.series.forEach((series, seriesIndex) => {
            const values = series?.values;
            if (Array.isArray(values) && values.length !== categoryCount) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [index, 'series', seriesIndex, 'values'],
                message: `series[${seriesIndex}].values has ${values.length} entries but the chart declares ${categoryCount} categories — values and categories must match in length and order.`,
              });
            }
          });
        }
      });
    });
}

// The explicit type pin goes with the per-member GenUIComponent union above:
// left to inference, the union-in-array instantiation collapses to `{}` in
// consumers (see the GenUIComponent doc comment).
const GenUIComponentsArraySchema = buildGenUiComponentsArraySchema(GenUIComponentSchema) as unknown as z.ZodType<GenUIComponent[]>;

export const RenderUiSchema = z.object({
  components: GenUIComponentsArraySchema,
});

// ============================================================
// generate_app — Generative UI canvas apps (Track 2, sandboxed webview)
// ============================================================

/**
 * Hard cap on a generate_app HTML bundle, serialized as UTF-8. Mirrors
 * HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes in @polo-ai/shared (this package
 * must not import shared — it is a leaf dependency — so the value is pinned
 * here and guarded by a test on the shared side).
 */
export const GENERATE_APP_MAX_HTML_BYTES = 512 * 1024;
/** Max length of the app id / updateOf reference (also a traversal guard: ids never contain path separators). */
export const GENERATE_APP_MAX_ID_LENGTH = 64;

const GENERATE_APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const GenerateAppSchema = z.object({
  title: z.string().min(1).max(120).describe('Short display name shown on the app card.'),
  html: z
    .string()
    .min(1)
    .describe(
      'Complete single-file HTML document. Self-contained: no external http(s) resources, no @polo-ai/sdk, no poloai:// links. Hard limit 512KB.'
    ),
  updateOf: z
    .string()
    .max(GENERATE_APP_MAX_ID_LENGTH)
    .regex(GENERATE_APP_ID_PATTERN, 'updateOf must be an app id returned by a previous generate_app call')
    .optional()
    .describe('Id of an existing app to fully rewrite. Omit to create a new app.'),
});

export const ScriptSandboxSchema = z.object({
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Inline script source to execute in a sandboxed subprocess.'),
  inputFiles: z.array(z.string()).optional().describe('Optional input file paths relative to the session directory.'),
  stdin: z.string().optional().describe('Optional stdin payload passed to the script process.'),
  timeoutMs: z.number().min(1).max(15000).optional().describe('Optional timeout in milliseconds (default 5000, max 15000).'),
});

export const RenderTemplateSchema = z.object({
  source: z.string().describe('Source slug (e.g., "linear", "gmail")'),
  template: z.string().describe('Template ID (e.g., "issue-detail", "issue-list")'),
  data: z.record(z.string(), z.unknown()).describe('JSON data to render into the template'),
});

export const SendDeveloperFeedbackSchema = z.object({
  message: z.string().describe('Freeform markdown feedback — be detailed, use headings, lists, code blocks. Include what happened, what you expected, what would help, or any ideas/suggestions.'),
});

// Browser tool schema (single CLI-like tool for all browser actions)
export const BrowserToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Browser command as a string (e.g., "click @e1") or array (e.g., ["evaluate", "var x = 1; x + 2"]). Array mode preserves semicolons and whitespace in arguments.'),
});

export const SpawnSessionSchema = z.object({
  help: z.boolean().optional().describe('If true, returns available connections, models, and sources instead of creating a session'),
  prompt: z.string().optional().describe('Instructions for the new session (required when not in help mode)'),
  name: z.string().optional().describe('Session name'),
  llmConnection: z.string().optional().describe('Connection slug (e.g., "anthropic-api", "codex")'),
  model: z.string().optional().describe('Model ID override'),
  enabledSourceSlugs: z.array(z.string()).optional().describe('Source slugs to enable in the new session'),
  permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional().describe('Permission mode for the new session'),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    .describe('Reasoning level for the new session. Silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash). Omit to inherit the workspace default.'),
  labels: z.array(z.string()).optional().describe('Labels for the new session'),
  workingDirectory: z.string().optional().describe('Working directory for the new session'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional().describe('Files to include with the prompt'),
});

// Session self-management tools
export const SetSessionLabelsSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to update. Omit to update the current session.'),
  labels: z.array(z.string()).describe('Labels to set (replaces all existing labels)'),
});

export const SetSessionStatusSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to update. Omit to update the current session.'),
  status: z.string().describe('Status to set (e.g., "todo", "in_progress", "done")'),
});

export const GetSessionInfoSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to query. Omit to get info about the current session.'),
});

export const ListSessionsSchema = z.object({
  status: z.string().optional().describe('Filter by status'),
  label: z.string().optional().describe('Filter by label'),
  search: z.string().optional().describe('Substring match on session name'),
  sortBy: z.enum(['recent', 'name', 'status']).optional().describe('Sort order (default: recent)'),
  limit: z.number().optional().describe('Max sessions to return (default 20, max 100)'),
  offset: z.number().optional().describe('Skip first N results (for pagination)'),
});

// Inter-session messaging
export const SendAgentMessageSchema = z.object({
  sessionId: z.string().describe('Target session ID to send the message to'),
  message: z.string().describe('The message to send to the target session'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional().describe('Files to include with the message'),
});

export const ListMessagingChannelsSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to list bindings for. Defaults to current session.'),
});

export const UnbindMessagingChannelSchema = z.object({
  platform: z.enum(['telegram', 'whatsapp']).optional().describe('Platform to unbind. If omitted, unbinds all.'),
});

// ============================================================
// Canonical Tool Descriptions (base — no DOC_REFS)
// ============================================================

export const TOOL_DESCRIPTIONS = {
  SubmitPlan: `Submit a plan for user review.

Call this after you have written your plan to a markdown file using the Write tool.
The plan will be displayed to the user in a special formatted view.

**IMPORTANT:** After calling this tool:
- Execution will be **automatically paused** to present the plan to the user
- No further tool calls or text output will be processed after this tool returns
- The conversation will resume when the user responds (accept, modify, or reject the plan)
- Do NOT include any text or tool calls after SubmitPlan - they will not be executed`,

  config_validate: `Validate Polo AI configuration files.

Use this after editing configuration files to check for errors before they take effect.
Returns structured validation results with errors, warnings, and suggestions.

**Targets:**
- \`config\`: Validates config.json (workspaces, model, settings)
- \`sources\`: Validates all source config.json files
- \`statuses\`: Validates statuses config.json
- \`preferences\`: Validates preferences.json
- \`permissions\`: Validates permissions.json files
- \`automations\`: Validates automations.json configuration
- \`tool-icons\`: Validates tool-icons.json
- \`all\`: Validates all configuration files`,

  skill_validate: `Validate a skill's SKILL.md file.

Checks:
- Slug format (lowercase alphanumeric with hyphens)
- SKILL.md exists and is readable
- YAML frontmatter is valid with required fields (name, description)
- Content is non-empty after frontmatter
- Icon format if present (svg/png/jpg)`,

  mermaid_validate: `Validate Mermaid diagram syntax before outputting.

Use this when:
- Creating complex diagrams with many nodes/relationships
- Unsure about syntax for a specific diagram type
- Debugging a diagram that failed to render

Returns validation result with specific error messages if invalid.`,

  source_test: `Validate, test, and (by default) activate a source configuration.

**This tool performs:**
1. **Schema validation**: Validates config.json structure
2. **Icon handling**: Checks/downloads icon if configured
3. **Completeness check**: Warns about missing guide.md/icon/tagline
4. **Connection test**: Tests if the source is reachable
5. **Auth status**: Checks if source is authenticated
6. **Auto-enable** (default): If validation passes, flip \`enabled: true\` in config (if needed) and activate the source in the running session so its tools become available without a restart.

Pass \`autoEnable: false\` to keep pure validation behavior (no config or session mutations).`,

  source_oauth_trigger: `Start OAuth authentication for an MCP source.

This tool initiates the OAuth 2.0 + PKCE flow for sources that require authentication.

**Prerequisites:**
- Source must exist in the current workspace
- Source must be type 'mcp' with authType 'oauth'
- Source must have a valid MCP URL

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_google_oauth_trigger: `Trigger Google OAuth authentication for a Google API source.

Opens a browser window for the user to sign in with their Google account.

**Supported services:** Gmail, Calendar, Drive, Docs, Sheets, YouTube, Search Console

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_slack_oauth_trigger: `Trigger Slack OAuth authentication for a Slack API source.

Opens a browser window for the user to sign in with their Slack account.

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_microsoft_oauth_trigger: `Trigger Microsoft OAuth authentication for a Microsoft API source.

Opens a browser window for the user to sign in with their Microsoft account.

**Supported services:** Outlook, Calendar, OneDrive, Teams, SharePoint

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_credential_prompt: `Prompt the user to enter credentials for a source.

Use this when a source requires authentication that isn't OAuth.
The user will see a secure input UI with appropriate fields based on the auth mode.

**Auth Modes:**
- \`bearer\`: Single token field (Bearer Token, API Key)
- \`basic\`: Username and Password fields
- \`header\`: API Key with custom header name shown
- \`query\`: API Key for query parameter auth
- \`multi-header\`: Multiple API keys with custom header names

**IMPORTANT:** After calling this tool, execution will be paused for user input.`,

  request_user_input: `Ask the user 1-3 structured questions with selectable options when their answer changes the outcome of your work.

Use this ONLY for product-level decisions that affect the user's results or permissions — never for internal implementation details or issues you can resolve yourself.

**Rules:**
- 1 to 3 questions per call; each question has 2 to 4 preset options.
- \`id\`: 1-64 chars, letters/digits/"_"/"-" only. Question ids must be unique within the call; option ids unique within their question.
- \`header\`: short section label (max 24 chars). \`question\`: the full question (max 500 chars).
- \`multiple: true\` makes a question multi-select; otherwise single-select.
- Mark at most one option per question as \`recommended: true\` and explain why in its description.
- \`exclusive: true\` (multi-select only) marks an option that excludes all other choices (e.g. "don't send notifications"). Never infer exclusivity from wording — only set it when the option is truly exclusive.
- A free-text "Other" option (max 2000 chars) is added automatically by the UI. NEVER declare an option with id "${REQUEST_USER_INPUT_OTHER_OPTION_ID}" or add your own "Other" option.

**IMPORTANT:** After calling this tool, execution pauses until the user answers or skips. Do not output further content — the conversation resumes with their answers.`,

  update_user_preferences: `Update stored user preferences. Use this when you learn information about the user that would be helpful to remember for future conversations. This includes their name, timezone, location, preferred language, or any other relevant notes. Only update fields you have confirmed information about - don't guess.`,

  transform_data: `Transform data files using a script and write structured output for datatable/spreadsheet blocks, or extract HTML content for html-preview blocks.

Use this tool when you need to transform large datasets (20+ rows) into structured JSON for display, or extract/decode content for rich previews. Write a transform script that reads the input file and produces an output file, then reference it via \`"src"\` in your datatable/spreadsheet/html-preview/pdf-preview/image-preview block.

**Workflow:**
1. Call \`transform_data\` with a script that reads input files and writes output
2. Output a datatable/spreadsheet block with \`"src": "data/output.json"\`, an html-preview block with \`"src": "data/output.html"\`, a pdf-preview block with \`"src": "data/output.pdf"\`, or an image-preview block with \`"src": "data/output.png"\`

**Script conventions:**
- Input file paths are passed as command-line arguments (last arg = output file path)
- Python: \`sys.argv[1:-1]\` = input files, \`sys.argv[-1]\` = output path
- Node/Bun: \`process.argv.slice(2, -1)\` = input files, \`process.argv.at(-1)\` = output path
- For datatable/spreadsheet: output must be valid JSON: \`{"title": "...", "columns": [...], "rows": [...]}\`
- For html-preview: output is an HTML file (any valid HTML)

**Security:** Runs in an isolated subprocess with no access to API keys or credentials. 30-second timeout.`,

  render_ui: `Render 1-8 interactive UI cards inline in the chat with declarative JSON components.

Use this instead of plain text when the answer is actionable or data-dense. The component catalog below is the per-type guide — what each "type" is for and how it behaves.

**Value semantics** (pick per meaning, not per sign):
- percent table columns render as up/down moves (+, green/red) by default. For levels and proportions — loss rate, utilization, weight, share — set the column \`"semantics"\`: \`"rate"\` or \`"share"\` so values render unsigned and neutral — 6.8% never looks like good news.
- \`stat-card\` accepts \`"format"\`: \`"number"\` (thousands separators) | \`"percent"\` (0.093 → 9.3%) | \`"currency"\` (thousands + \`"currency"\` prefix). Omit \`format\` to show the raw value (e.g. with a unit).
- \`stat-card\` \`"goodWhen"\` controls delta coloring: \`"down"\` (queues, errors, costs — a rise is bad news) renders increases red and decreases green; \`"neutral"\` renders the delta muted. Default \`"up"\` keeps rises green.
- badge table columns can map values to colors via \`"badgeColors"\`: \`{"高": "error", "中": "warning", "低": "success"}\`; unmapped values stay neutral.

**Rules:**
- Keep the payload small: skeleton inline, data in files. Payloads over 4096 bytes are rejected. \`chart\` is the exception — its few bounded points ride inline.
- Give every component a unique stable "id" — reusing an id in a later call updates that card in place.
- If this tool returns a validation error, fix the payload and retry once.
- Prefer datatable/spreadsheet blocks for static display; prefer render_ui when the user should act.
- View-state operations (filter/sort/group, chart legend/range) are handled client-side by the cards; reserve action-buttons for semantic follow-ups that need the model.`,

  generate_app: `Create a self-contained single-file HTML app that renders in a sandboxed webview card in the chat.

Use this when the user needs a small interactive artifact — a calculator, a visual dashboard mock, a converter, a playable demo — that declarative render_ui cards cannot express.

**Contract (violations are rejected):**
- \`html\` MUST be one complete HTML document, fully self-contained: inline CSS/JS only.
- No external network references: no \`http(s)://\` in src/href/CSS url() (SVG/XML xmlns namespaces are the only exception). No CDN, no web fonts, no image hotlinks — use data: URIs.
- Never reference \`@polo-ai/sdk\`.
- Host bridge: the ONLY sanctioned deep link is \`poloai://action/ui-event/{sessionId}?cardId=…&eventId=…&type=button-click|value-change|submit&callbackId=…\` plus exactly one of \`payload\` (URL-encoded JSON object, ≤8KB) or \`payloadSrc\` (path of a JSON file inside the session data/ directory). It only works when the bundle declares \`<meta name="polo-bridge-capabilities" content="ui-event">\` AND the desktop observed that declaration in the exact document it attached — otherwise every event is rejected (capability_denied). Read \`poloCard\` and \`poloSession\` from the URL query the host appends to your file URL to fill in cardId/sessionId. REUSE one callbackId for every event of your card (it pairs the acks/errors; rotating it exhausts the host's per-page slots). At most 10 events per second per card. Inside the JSON payload: "modelContext" is a short summary for the assistant (hard 2KB cap, silently truncated — keep it tight); "privateState" is any JSON echoed back ONLY to your card via a ui_state message; other keys are ignored by the host.
- Any other \`poloai://\` link is rejected.
- Hard limit: 512 KB per bundle.

**Updates:** pass \`updateOf\` with the app id from a previous call to rewrite that app in place (version increments, full rewrite — send the COMPLETE html every time). Omit \`updateOf\` to create a new app.

If this tool returns a validation error, fix the html and retry once.`,

  script_sandbox: `Run quick inline diagnostics in a sandboxed subprocess with network isolation.

Use this for short Python/Node/Bun snippets when strict Explore-mode Bash parsing blocks inline diagnostics.

**Behavior:**
- Executes script source from \`script\` in a temporary file
- Returns stdout/stderr, exit code, duration, and timeout status
- Accepts optional input files and stdin
- Requires enforced network and filesystem isolation; if unsupported or unusable, execution is blocked

**Safety:**
- Sensitive credential env vars are stripped
- Input files are restricted to the current session directory
- Filesystem writes are restricted to the current session directory
- Timeout is capped (default 5000ms, max 15000ms)
- Network/filesystem isolation is required in all permission modes; if unavailable, execution is blocked`,

  render_template: `Render a source's HTML template with data.

Use this when a source provides HTML templates for rich rendering of its data (e.g., issue detail views, email threads, ticket summaries).

**Workflow:**
1. Fetch data from the source (via MCP tools or API calls)
2. Call \`render_template\` with the source slug, template ID, and data
3. Output an \`html-preview\` block with the returned file path as \`"src"\`

**Available templates** are documented in each source's \`guide.md\` under the "Templates" section.

Templates use Mustache syntax — the tool handles rendering and writes the output HTML to the session data folder.`,

  browser_tool: `Run browser actions using a CLI-like command (string or array input).

All browser interactions use this single tool with strict validation and actionable feedback.
String mode supports batching with semicolons: \`fill @e1 value; fill @e2 value; click @e3\`
Batch stops after navigation commands (click, navigate, back, forward) since page state may change.

Array mode bypasses string parsing and preserves raw arguments exactly (recommended for semicolons, tabs, and newlines):
- \`["evaluate", "var x = 1; var y = 2; x + y"]\`
- \`["paste", "Name\\tAge\\nAlice\\t30"]\`

Examples:
- \`--help\`
- \`open\`
- \`navigate https://example.com\`
- \`snapshot\`
- \`find login button\` — search elements by keyword
- \`click @e12\`
- \`click-at 350 200\` — click at pixel coordinates (for canvas elements)
- \`fill @e5 user@example.com\`
- \`type Hello World\` — type into currently focused element (no ref needed)
- \`select @e3 optionValue\`
- \`select @e75 CNAME --assert-text Target --timeout 3000\`
- \`set-clipboard Name\\tAge\\nAlice\\t30\` — write text to clipboard
- \`get-clipboard\` — read clipboard text content
- \`paste Name\\tAge\\nAlice\\t30\` — set clipboard and trigger Ctrl/Cmd+V
- \`scroll down 800\`
- \`evaluate document.title\`
- \`console 50 error\`
- \`screenshot\` — raw screenshot
- \`screenshot --annotated\` — screenshot with @eN labels overlaid on interactive elements
- \`screenshot-region 100 200 640 480\`
- \`screenshot-region --ref @e12 --padding 8\`
- \`screenshot-region --selector div[data-testid="chart"]\`
- \`window-resize 1440 900\`
- \`network 50 failed\`
- \`wait network-idle 8000\`
- \`key Enter\`
- \`key k meta\`
- \`downloads wait 15000\`
- \`focus [windowId]\` — focus existing browser window (no new window)
- \`windows\` — list current browser windows and ownership state
- \`release\` — dismiss the agent control overlay when done
- \`close\` — close and destroy the browser window
- \`hide\` — hide the window while preserving state`,

  call_llm: `Invoke a secondary LLM for focused subtasks. Use for:
- Cost optimization: use a smaller model for simple tasks (summarization, classification)
- Structured output: JSON schema compliance via prompt instructions
- Parallel processing: call multiple times in one message - all run simultaneously
- Context isolation: process content without polluting main context

Put text/content directly in the 'prompt' parameter. Do NOT pass inline text via attachments.
Only use 'attachments' for existing file paths on disk - the tool loads file content automatically.
For large files (>2000 lines), use {path, startLine, endLine} to select a portion.`,

  spawn_session: `Create a new session that runs independently with its own prompt, connection, model, and sources.

Use this to delegate tasks to parallel sessions — research, analysis, drafts, or any work that benefits from separate context.

Call with help=true first to discover available connections, models, and sources.
When spawning, the 'prompt' parameter is required.

Optional overrides: \`model\`, \`llmConnection\`, \`permissionMode\`, \`thinkingLevel\`, \`enabledSourceSlugs\`, \`labels\`, \`workingDirectory\`. Omitted fields inherit from the spawning session or the workspace default.

\`thinkingLevel\` is silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash) — the SDK drops the reasoning param rather than erroring. Use it when you want to force deeper reasoning on a supported model, or set it to \`off\` when spawning a session that doesn't need to think.

The spawned session appears in the session list and runs fire-and-forget.
Only use 'attachments' for existing file paths on disk — the tool reads them automatically.`,

  send_developer_feedback: `Send freeform feedback to the Polo AI development team.

Use this to share anything that would help improve the product — issues you hit, ideas for better tools, suggestions for improved workflows, or patterns you notice. Write in markdown with as much detail as possible. This is your direct line to the developers.`,

  set_session_labels: `Set labels on the current session or a specific session by ID. Replaces all existing labels.

Use this to tag sessions for filtering or to trigger label-based automations (LabelAdd/LabelRemove events).
Pass an empty array to clear all labels. Omit sessionId to target the current session.`,

  set_session_status: `Set the status of the current session or a specific session by ID (e.g., "todo", "in_progress", "done").

Use this to signal completion or trigger status-based automations (SessionStatusChange events).
Omit sessionId to target the current session.`,

  get_session_info: `Get metadata about the current session or a specific session by ID.

Returns labels, status, name, permission mode, and other details.
Call with no arguments to introspect your own session state.`,

  list_sessions: `List sessions in the workspace. Returns total count + paginated results.

Use filters (status, label, search) to narrow results instead of fetching everything. Default limit is 20 sessions.
Use get_session_info for full details on a specific session (list-then-detail pattern).`,

  send_agent_message: `Send a message to another session. The message is delivered with your session ID so the target can reply back.

Use this to coordinate with spawned sessions, send follow-up instructions, or relay information between sessions.
Use list_sessions to find session IDs, or use the sessionId returned by spawn_session.

The target session receives your message with a sender envelope containing your session ID, so it can use send_agent_message to reply.`,

  list_messaging_channels: `List messaging channels (Telegram, WhatsApp) bound to a session.
Shows which external chat apps are connected and can send/receive messages.`,

  unbind_messaging_channel: `Disconnect a messaging channel from the current session.
Messages will no longer be forwarded between the chat app and this session.`,
} as const;

// ============================================================
// Tool Definition Type
// ============================================================

/** Handler function signature for session tools. */
export type SessionToolHandler = (ctx: SessionToolContext, args: any) => Promise<ToolResult>;

/** Where a session tool is executed. */
export type SessionToolExecutionMode = 'registry' | 'backend';

/** Safe/Explore mode behavior for a session tool. */
export type SessionToolSafeMode = 'allow' | 'block';

interface SessionToolDefBase {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Whether this tool is allowed in Explore/Safe mode. */
  safeMode: SessionToolSafeMode;
  /** Whether this tool only reads data (no side effects). Enables parallel execution in backends that support it. */
  readOnly?: boolean;
}

/** Tool executed from the canonical registry (requires a concrete handler). */
export interface RegistrySessionToolDef extends SessionToolDefBase {
  executionMode: 'registry';
  handler: SessionToolHandler;
}

/** Tool executed by backend-specific adapters (Pi/Claude). */
export interface BackendSessionToolDef extends SessionToolDefBase {
  executionMode: 'backend';
  handler: null;
}

/** A single session tool definition combining name, description, schema, mode, and handler. */
export type SessionToolDef = RegistrySessionToolDef | BackendSessionToolDef;

// ============================================================
// Canonical Tool Registry
// ============================================================

export const SESSION_TOOL_DEFS: SessionToolDef[] = [
  { name: 'SubmitPlan', description: TOOL_DESCRIPTIONS.SubmitPlan, inputSchema: SubmitPlanSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSubmitPlan },
  { name: 'config_validate', description: TOOL_DESCRIPTIONS.config_validate, inputSchema: ConfigValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleConfigValidate },
  { name: 'skill_validate', description: TOOL_DESCRIPTIONS.skill_validate, inputSchema: SkillValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleSkillValidate },
  { name: 'mermaid_validate', description: TOOL_DESCRIPTIONS.mermaid_validate, inputSchema: MermaidValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleMermaidValidate },
  { name: 'source_test', description: TOOL_DESCRIPTIONS.source_test, inputSchema: SourceTestSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSourceTest },
  { name: 'source_oauth_trigger', description: TOOL_DESCRIPTIONS.source_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSourceOAuthTrigger },
  { name: 'source_google_oauth_trigger', description: TOOL_DESCRIPTIONS.source_google_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleGoogleOAuthTrigger },
  { name: 'source_slack_oauth_trigger', description: TOOL_DESCRIPTIONS.source_slack_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSlackOAuthTrigger },
  { name: 'source_microsoft_oauth_trigger', description: TOOL_DESCRIPTIONS.source_microsoft_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleMicrosoftOAuthTrigger },
  { name: 'source_credential_prompt', description: TOOL_DESCRIPTIONS.source_credential_prompt, inputSchema: CredentialPromptSchema, executionMode: 'registry', safeMode: 'block', handler: handleCredentialPrompt },
  // Structured user questions — only registered for desktop interactive turns
  // (see SessionToolFilterOptions.allowRequestUserInput). Safe in all permission
  // modes: asking a question must not trigger another permission confirmation.
  { name: 'request_user_input', description: TOOL_DESCRIPTIONS.request_user_input, inputSchema: RequestUserInputArgsSchema, executionMode: 'registry', safeMode: 'allow', handler: handleRequestUserInput },
  // Generative UI inline cards — same desktop-only gating as request_user_input
  // (see SessionToolFilterOptions.allowRenderUi), plus the generativeUI.inline
  // feature toggle folded into the flag by the session layer. Declared JSON
  // only: no code execution, no network — safe in all permission modes.
  { name: 'render_ui', description: TOOL_DESCRIPTIONS.render_ui, inputSchema: RenderUiSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleRenderUi },
  // Generative UI canvas apps — same desktop-only gating as render_ui (see
  // SessionToolFilterOptions.allowGenerateApp), plus the generativeUI.canvas
  // feature toggle folded into the flag by the session layer. The handler is
  // fail-closed: it validates the bundle (size, no external refs, no SDK, no
  // poloai:// bridge) before anything touches disk, then writes into the
  // session data dir only.
  { name: 'generate_app', description: TOOL_DESCRIPTIONS.generate_app, inputSchema: GenerateAppSchema, executionMode: 'registry', safeMode: 'allow', handler: handleGenerateApp },
  { name: 'update_user_preferences', description: TOOL_DESCRIPTIONS.update_user_preferences, inputSchema: UpdatePreferencesSchema, executionMode: 'registry', safeMode: 'block', handler: handleUpdatePreferences },
  { name: 'transform_data', description: TOOL_DESCRIPTIONS.transform_data, inputSchema: TransformDataSchema, executionMode: 'registry', safeMode: 'allow', handler: handleTransformData },
  { name: 'script_sandbox', description: TOOL_DESCRIPTIONS.script_sandbox, inputSchema: ScriptSandboxSchema, executionMode: 'registry', safeMode: 'allow', handler: handleScriptSandbox },
  { name: 'render_template', description: TOOL_DESCRIPTIONS.render_template, inputSchema: RenderTemplateSchema, executionMode: 'registry', safeMode: 'allow', handler: handleRenderTemplate },
  { name: 'send_developer_feedback', description: TOOL_DESCRIPTIONS.send_developer_feedback, inputSchema: SendDeveloperFeedbackSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSendDeveloperFeedback },
  { name: 'call_llm', description: TOOL_DESCRIPTIONS.call_llm, inputSchema: CallLlmSchema, executionMode: 'backend', safeMode: 'allow', readOnly: true, handler: null },
  { name: 'spawn_session', description: TOOL_DESCRIPTIONS.spawn_session, inputSchema: SpawnSessionSchema, executionMode: 'backend', safeMode: 'block', handler: null },
  // Browser tool (backend-specific — requires BrowserPaneManager in Electron)
  // Single CLI-like tool that handles all browser actions via command string.
  { name: 'browser_tool', description: TOOL_DESCRIPTIONS.browser_tool, inputSchema: BrowserToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Session self-management tools (registry — use context callbacks to reach SessionManager)
  { name: 'set_session_labels', description: TOOL_DESCRIPTIONS.set_session_labels, inputSchema: SetSessionLabelsSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionLabels },
  { name: 'set_session_status', description: TOOL_DESCRIPTIONS.set_session_status, inputSchema: SetSessionStatusSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionStatus },
  { name: 'get_session_info', description: TOOL_DESCRIPTIONS.get_session_info, inputSchema: GetSessionInfoSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleGetSessionInfo },
  { name: 'list_sessions', description: TOOL_DESCRIPTIONS.list_sessions, inputSchema: ListSessionsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListSessions },
  // Inter-session messaging
  { name: 'send_agent_message', description: TOOL_DESCRIPTIONS.send_agent_message, inputSchema: SendAgentMessageSchema, executionMode: 'registry', safeMode: 'block', handler: handleSendAgentMessage },
  // Messaging gateway tools
  { name: 'list_messaging_channels', description: TOOL_DESCRIPTIONS.list_messaging_channels, inputSchema: ListMessagingChannelsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListMessagingChannels },
  { name: 'unbind_messaging_channel', description: TOOL_DESCRIPTIONS.unbind_messaging_channel, inputSchema: UnbindMessagingChannelSchema, executionMode: 'registry', safeMode: 'block', handler: handleUnbindMessagingChannel },
];

export interface SessionToolFilterOptions {
  /** Include the experimental send_developer_feedback tool. */
  includeDeveloperFeedback?: boolean;
  /**
   * Only desktop interactive main-session turns enable request_user_input.
   * Messaging, automation, headless/CLI, internal, and hidden/mini turns
   * MUST NOT enable it — every non-desktop source fails closed. Defaults
   * to false so backends must opt in explicitly.
   */
  allowRequestUserInput?: boolean;
  /**
   * Only desktop interactive main-session turns enable render_ui (Generative
   * UI inline cards), and only while the generativeUI.inline feature toggle
   * is on — the session layer folds remote capability + local Settings kill
   * switch into this flag before each turn. Every non-desktop source and any
   * disabled toggle state fails closed. Defaults to false so backends must
   * opt in explicitly.
   */
  allowRenderUi?: boolean;
  /**
   * Only desktop interactive main-session turns enable generate_app (Generative
   * UI canvas apps), and only while the generativeUI.canvas feature toggle is
   * on — same shape as allowRenderUi. Every non-desktop source and any
   * disabled toggle state fails closed. Defaults to false so backends must opt
   * in explicitly.
   */
  allowGenerateApp?: boolean;
  /**
   * POO-104 model-side component index (proposal §5.7): the enabled-component
   * catalog snapshot appended, one `type — one-line description` per entry, to
   * the render_ui tool description. Description-only — it never changes which
   * tools are visible or what the input schema accepts; the render_ui schema
   * keeps validating the full builtin union, so a stale catalog can only
   * under-describe, never reject. Omit for the builtin catalog.
   */
  renderUiCatalog?: GenUiComponentDescriptor[];
}

/**
 * Return session tools with optional feature filtering.
 *
 * Callers should use this helper instead of filtering ad hoc so tool visibility
 * stays consistent across the Claude and Pi backend tool surfaces.
 */
export function getSessionToolDefs(options?: SessionToolFilterOptions): SessionToolDef[] {
  const includeDeveloperFeedback = options?.includeDeveloperFeedback ?? true;
  const allowRequestUserInput = options?.allowRequestUserInput ?? false;
  const allowRenderUi = options?.allowRenderUi ?? false;
  const allowGenerateApp = options?.allowGenerateApp ?? false;

  return SESSION_TOOL_DEFS.filter(def => {
    if (!includeDeveloperFeedback && def.name === 'send_developer_feedback') {
      return false;
    }
    if (!allowRequestUserInput && def.name === 'request_user_input') {
      return false;
    }
    if (!allowRenderUi && def.name === 'render_ui') {
      return false;
    }
    if (!allowGenerateApp && def.name === 'generate_app') {
      return false;
    }
    return true;
  });
}

/**
 * Build a name->definition registry with optional feature filtering.
 */
export function getSessionToolRegistry(options?: SessionToolFilterOptions): Map<string, SessionToolDef> {
  return new Map(getSessionToolDefs(options).map(def => [def.name, def]));
}

/**
 * Return session tool names with optional feature filtering.
 */
export function getSessionToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).map(def => def.name));
}

/**
 * Return backend-executed tool names with optional feature filtering.
 */
export function getSessionBackendToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).filter(d => d.executionMode === 'backend').map(d => d.name));
}

/**
 * Return registry-executed tool names with optional feature filtering.
 */
export function getSessionRegistryToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).filter(d => d.executionMode === 'registry').map(d => d.name));
}

export interface SessionToolNameOptions extends SessionToolFilterOptions {
  /** Optional name prefix for consumers (e.g. 'mcp__session__'). */
  prefix?: string;
}

/**
 * Return session tool names that are allowed in Explore/Safe mode.
 */
export function getSessionSafeAllowedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .filter(def => def.safeMode === 'allow')
      .map(def => `${prefix}${def.name}`)
  );
}

/**
 * Return session tool names that are blocked in Explore/Safe mode.
 */
export function getSessionSafeBlockedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .filter(def => def.safeMode === 'block')
      .map(def => `${prefix}${def.name}`)
  );
}

// ============================================================
// Derived Lookups
// ============================================================

/** Set of session tool names for quick membership checks. */
export const SESSION_TOOL_NAMES = new Set(SESSION_TOOL_DEFS.map(d => d.name));

/** Session tool names that must be handled by backend-specific adapters (Pi/Claude). */
export const SESSION_BACKEND_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'backend').map(d => d.name)
);

/** Session tool names that are always executable from the canonical registry. */
export const SESSION_REGISTRY_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'registry').map(d => d.name)
);

/** Session tool names allowed in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_ALLOWED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.safeMode === 'allow').map(d => d.name)
);

/** Session tool names blocked in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_BLOCKED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.safeMode === 'block').map(d => d.name)
);

/** Map from tool name → definition for O(1) lookup. */
export const SESSION_TOOL_REGISTRY = new Map(SESSION_TOOL_DEFS.map(d => [d.name, d]));

// ============================================================
// JSON Schema Converter (for MCP / Pi consumers)
// ============================================================

export interface JsonSchemaToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Convert session tool definitions to JSON Schema format.
 *
 * @param opts.prefix - Optional prefix for tool names (e.g., 'mcp__session__' for Pi)
 * @param opts.includeDeveloperFeedback - Include experimental feedback tool in output
 * @param opts.renderUiCatalog - POO-104 model-side component index: appended
 *   to the render_ui description as one `type — one-liner` per enabled
 *   component. Defaults to the builtin catalog.
 * @returns Array of tool definitions with JSON Schema inputSchema
 */
export function getToolDefsAsJsonSchema(opts?: {
  prefix?: string;
  includeDeveloperFeedback?: boolean;
  allowRequestUserInput?: boolean;
  allowRenderUi?: boolean;
  allowGenerateApp?: boolean;
  renderUiCatalog?: GenUiComponentDescriptor[];
}): JsonSchemaToolDef[] {
  const prefix = opts?.prefix || '';
  const defs = getSessionToolDefs({
    includeDeveloperFeedback: opts?.includeDeveloperFeedback,
    allowRequestUserInput: opts?.allowRequestUserInput,
    allowRenderUi: opts?.allowRenderUi,
    allowGenerateApp: opts?.allowGenerateApp,
  });
  const renderUiCatalog = opts?.renderUiCatalog ?? GENUI_BUILTIN_COMPONENT_DESCRIPTORS;

  return defs.map(def => {
    // Explicit `as any` avoids TS2589 ("type instantiation is excessively deep")
    // caused by zodToJsonSchema inferring deep generic chains from union schemas.
    const jsonSchema = zodToJsonSchema(def.inputSchema as any, { $refStrategy: 'none' }) as Record<string, unknown>;
    // Strip metadata not needed by MCP/Pi consumers
    delete jsonSchema.$schema;
    delete jsonSchema.additionalProperties;
    return {
      name: prefix + def.name,
      description: def.name === 'render_ui'
        ? buildRenderUiToolDescription(def.description, renderUiCatalog)
        : def.description,
      inputSchema: jsonSchema,
    };
  });
}
