# LLM Tool (`call_llm`)

Invoke a secondary LLM for focused subtasks. The tool loads file content automatically from paths you provide.

## When to Use

| Use Case | Model | Features |
|----------|-------|----------|
| Summarize large file | haiku | `attachments` |
| Classify content | haiku | `outputFormat: "classification"` |
| Extract structured data | haiku | `outputSchema` |
| Focused review pass | sonnet | `systemPrompt` + `attachments` |
| Parallel processing | any | Multiple calls in one message |

## How It Runs

There is one execution path: the call goes through the **agent's own model connection** (the same provider/auth the current session uses) — there is no separate API-key mode and no per-call OAuth distinction. Whatever connection the session is on is what `call_llm` uses, and the `model` parameter selects the model on that connection. If you pass a model the connection cannot serve, the backend falls back to a model it can serve and reports the **effective** model in the result.

- Structured output uses the connection's native structured-output support when available, with prompt-based enforcement as fallback.
- Each call is **read-only** and independent, so multiple calls in one message run in parallel.
- Each call has a **120-second timeout**.

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | string | Instructions for the LLM (required) |
| `attachments` | array | Text file paths to include (max 20). **Not for inline text** — put text in `prompt` |
| `model` | string | Model ID or short name (e.g. `"haiku"`, `"sonnet"`). Defaults to a fast model (Haiku) |
| `systemPrompt` | string | Optional system prompt |
| `maxTokens` | number | Max output tokens (1-64000, default 4096) |
| `temperature` | number | Sampling temperature 0-1 |
| `outputFormat` | enum | Predefined output format: `summary`, `classification`, `extraction`, `analysis`, `comparison`, `validation` |
| `outputSchema` | object | Custom JSON Schema for structured output |

> `thinking` / `thinkingBudget` no longer exist — the model handles its own reasoning. Passing them has no effect.

## Attachments

```typescript
// Simple file
attachments: ["/src/auth.ts"]

// Large file - use line range (required for files >2000 lines)
attachments: [{ path: "/logs/app.log", startLine: 1000, endLine: 1500 }]
```

**Text files only.** Image attachments (`.png`, `.jpg`, …) are rejected: `Image attachments are not supported. Use text files only.` Describe images in the chat instead, or have the main session read them with its own image support.

- Paths may be absolute, or **relative to the current session's directory**.
- Do not pass inline text through `attachments` — it is for files on disk only.

### Line Ranges

For files larger than 2000 lines or 500KB, you must specify a line range:

```typescript
{ path: "/path/to/large-file.log", startLine: 100, endLine: 600 }
```

The tool will tell you the file structure if you try to load a file that's too large.

### Supported Formats

**Text files**: any UTF-8 encoded file (`.ts`, `.js`, `.py`, `.md`, `.json`, etc.). No images, no binaries.

## Output Formats

| Format | Returns |
|--------|---------|
| `summary` | `{ summary, key_points[], word_count }` |
| `classification` | `{ category, confidence, reasoning }` |
| `extraction` | `{ items[], count }` |
| `analysis` | `{ findings[], issues[], recommendations[] }` |
| `comparison` | `{ similarities[], differences[], verdict }` |
| `validation` | `{ valid, errors[], warnings[] }` |

Or supply your own `outputSchema` (JSON Schema, `type: "object"`).

## Partial Results

If the subtask is truncated (the backend hits its own turn/step limit before finishing), the tool does not fail silently: the result is prefixed with `[Partial result — …]` and includes a warning. When you see that prefix, either split the task into smaller `call_llm` calls or reduce the input size — don't treat a partial result as complete.

## Parallel Processing

Call multiple times in a single message for parallel execution:

```
call_llm(prompt: "Summarize", attachments: ["/file1.ts"])
call_llm(prompt: "Summarize", attachments: ["/file2.ts"])
call_llm(prompt: "Summarize", attachments: ["/file3.ts"])
// All run simultaneously - ~3x faster than sequential!
```

Use cases for parallel calls:
- Analyze multiple files at once
- Get multiple perspectives on the same code
- Process batch data
- Generate variations

## Examples

### Summarize a File (Cheap)

```typescript
call_llm({
  prompt: "Summarize the main functionality",
  attachments: ["/src/auth/handler.ts"],
  model: "claude-haiku-4-5-20251001"
})
```

### Extract Structured Data

```typescript
call_llm({
  prompt: "Extract all API endpoints from this file",
  attachments: ["/src/routes.ts"],
  outputSchema: {
    type: "object",
    properties: {
      endpoints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            method: { type: "string" },
            path: { type: "string" },
            handler: { type: "string" }
          }
        }
      }
    },
    required: ["endpoints"]
  }
})
```

### Classify Content

```typescript
call_llm({
  prompt: "Classify this support ticket by urgency and category",
  attachments: ["/tickets/latest.txt"],
  outputFormat: "classification"
})
// Returns: { category: "billing", confidence: 0.92, reasoning: "..." }
```

### Focused Review with a Custom System Prompt

```typescript
call_llm({
  prompt: "Review this module for concurrency issues",
  systemPrompt: "You are a rigorous code reviewer. Report only real, demonstrable issues.",
  attachments: ["/src/queue.ts"],
  model: "claude-sonnet-4-6",
  maxTokens: 8192
})
```

## Constraints

| Constraint | Limit |
|------------|-------|
| Max attachments | 20 per call |
| Max text file size | 2000 lines or 500KB per attachment |
| Max total content | 2MB across all attachments |
| Max output | 64000 tokens (`maxTokens`, default 4096) |
| Timeout | 120 seconds per call |
| Attachment types | Text files only — **no images** |

## Error Handling

The tool provides detailed error messages with recovery suggestions. Common errors:

### Attachment Errors

| Error | Cause | Solution |
|-------|-------|----------|
| File not found | Path doesn't exist | Check path spelling; relative paths resolve against the session directory |
| File too large | >2000 lines or >500KB | Use line range: `{ path, startLine, endLine }` |
| Line range too large | Range exceeds 2000 lines | Reduce range or split into multiple calls |
| Image attachments are not supported. Use text files only. | Image path in `attachments` | Describe the image in the chat, or use the session's own image support |
| Binary file detected | Non-text file | Use only UTF-8 text files |
| Permission denied | Cannot read file | Check file permissions |
| Empty file | File has no content | Skip empty files |
| Broken symlink | Symlink target missing | Fix or remove symlink |

### Parameter Errors

| Error | Cause | Solution |
|-------|-------|----------|
| Invalid line range | startLine > endLine | Fix range values |
| Unknown model | Model not servable on this connection | Omit `model` (use the default) or pick a model from Settings → AI |
| Timeout after 120s | Input or task too large | Split into smaller calls; trim attachments |
| `[Partial result — …]` in output | Backend truncated the subtask | Split the task; don't treat partial output as final |

### API Errors

| Status | Meaning | Recovery |
|--------|---------|----------|
| 401 | Invalid/expired credentials | Re-authenticate in Settings → AI |
| 403 | Access denied | Verify model access on your plan |
| 429 | Rate limited | Reduce parallel calls, wait before retry |
| 500/502/503 | API unavailable | Retry in a few seconds |

## When NOT to Use

- You can reason through it yourself without needing a cheaper model
- The task requires your conversation context
- You need tools (Read, Bash, Glob) - use Task tool with subagents instead
- Simple one-liner responses that don't need isolation
- The input is an image — images are rejected; handle them in the main session
