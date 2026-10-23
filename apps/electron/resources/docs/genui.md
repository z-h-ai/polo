# Generative UI Guide

This guide covers Generative UI: declarative interactive cards via `render_ui` and sandboxed single-file HTML apps via `generate_app`. Use it before building anything the user should click, fill in, or watch update live.

## Overview

Generative UI has two tracks. They solve different problems and compose with the static preview blocks:

| Surface | Tool | Best For | Interactivity |
|---------|------|----------|---------------|
| **Card** (`render_ui`) | Declarative JSON components rendered inline in the chat | Answers the user should **act** on: KPIs with context, tables with row actions, charts, forms, confirmations | Buttons, forms, row actions — every interaction sends a message back to you (host-mediated) |
| **Canvas app** (`generate_app`) | A complete single-file HTML document in a sandboxed `<webview>` | Small artifacts that cards cannot express: calculators, mini demos, converters with live preview, visual toys | Full client-side JS logic, zero network |
| Markdown blocks | `datatable` / `spreadsheet` fences (see [data-tables.md](./data-tables.md)) | **Static** display of structured data — sort/filter/export, no follow-up | View-only (client-side sort/filter, nothing sent) |

**Key principle:** prefer declarative cards. `render_ui` covers almost every "show data + let the user act" case with a fraction of the tokens. Reach for a canvas app only when the interaction needs real client-side logic (state machines, live recalculation, drawing). And keep mutable state out of HTML in both tracks — cards take data from your payload, canvas apps declare it in `<meta name="polo-app-data">` and read it from the host.

## When to Use

### Use `render_ui` when…

- The user should **decide or act**: confirm a destructive step, pick from options, fill a small intake form.
- A few KPIs tell the story better than a paragraph (`stat-card`).
- Tabular results need **per-row follow-ups** ("draft follow-up", "open detail") — `data-table` with `rowAction`.
- A trend, distribution, share, or funnel fits in ≤24 categories and ≤3 series — `chart`.
- You want the answer to survive as a compact, restylable artifact instead of a wall of prose.

### Use `generate_app` when…

- The interaction needs **real client-side logic** cards cannot express: a tip splitter, an interactive unit converter, a playable demo, a what-if slider.
- The user will **manipulate and watch** something update live.

### Use something else when…

| Need | Use instead |
|------|-------------|
| Static table display, 20+ rows, sort/filter/export | `datatable` / `spreadsheet` block via `transform_data` — [data-tables.md](./data-tables.md) |
| Rich HTML **display** (email, newsletter, report), no interaction | `html-preview` block — [html-preview.md](./html-preview.md) |
| Structure, flow, sequence, ER diagrams | Mermaid diagram — [mermaid.md](./mermaid.md) |
| A source ships an HTML template for its data | `render_template` tool (outputs an `html-preview` block) |
| Row-level detail behind a chart | `data-table` (chart itself says: "use data-table for row-level detail") |

## Interactive UI Cards (`render_ui`)

### How It Works

- One `render_ui` call renders **1–8 components**; the whole payload must stay **≤ 4096 bytes**. If you need more, split into several calls or move data to a file (see [Data Rules](#data-rules-inline-vs-file-backed)).
- Every component needs an `id`, unique within one call. **Reusing an `id` in a later call updates that card in place** — this is how you refresh a `progress` bar or replace a table's data without re-rendering the thread.
- Cards are mounted from the tool call's input once it completes; the tool's own text output is not shown in the chat. Multiple `render_ui` calls in the same turn merge by component id (latest content wins).
- While the call is still streaming, the UI shows lightweight skeleton cards (component type + title only — never data).
- Components are **read-only** unless stated otherwise. Interactivity (`rowAction`, `action-buttons`, `form`) is host-mediated: a click becomes the **next user message**, not a direct tool call.
- If the tool returns a validation error, fix the issues it lists and retry once. Errors carry stable `[genui:<code>]` prefixes — see [Error Codes](#error-codes).

### Component Reference

Seven builtin components:

#### `stat-card` — single metric with optional delta and trend

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` | Yes | string | Unique within the call |
| `type` | Yes | `"stat-card"` | |
| `label` | Yes | string | Metric name, e.g. `"MRR"` |
| `value` | Yes | number \| string | The metric value |
| `title` | No | string | Card title above the metric |
| `format` | No | `"number"` \| `"percent"` \| `"currency"` | `number` adds thousands separators; `percent` renders `0.093` as `9.3%`; `currency` like `number` plus a prefix |
| `currency` | No | string ≤ 8 chars | Currency symbol/prefix for `format: "currency"` |
| `unit` | No | string | Suffix, e.g. `"users"` |
| `delta` | No | number | Fraction, e.g. `0.152` renders `+15.2%` |
| `trend` | No | `"up"` \| `"down"` \| `"flat"` | Arrow next to the delta |
| `goodWhen` | No | `"up"` \| `"down"` \| `"neutral"` | Default `"up"`. `"down"` means a rise is bad news (delta turns red); `"neutral"` stays gray |

```json
{ "id": "mrr", "type": "stat-card", "label": "MRR", "value": 128400,
  "format": "currency", "currency": "$", "delta": 0.152, "trend": "up" }
```

#### `data-table` — file-backed table with optional per-row actions

**Never accepts inline `rows`.** The data always comes from a JSON file you write first with `transform_data`.

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `id` / `type` | Yes | | As above |
| `columns` | Yes | 1–24 column objects | See below |
| `src` | Yes | string | JSON file path **inside the session `data/` directory**; the file must already exist (run `transform_data` first) |
| `title` | No | string | |
| `pageSize` | No | integer 5–100 | Rows per page |
| `rowAction` | No | `{ label ≤ 20, promptTemplate ≤ 500 }` | Per-row button. Clicking sends the next user message with `{{column.key}}` placeholders filled from that row (missing values become empty strings) |
| `detailTemplate` | No | string ≤ 500 | Per-row "detail" affordance. Fills the same placeholders but only **prefills** the input — the user still edits and sends |

Column object: `key`, `label`, `type` (`text` \| `number` \| `currency` \| `percent` \| `boolean` \| `date` \| `badge`, default `text`), plus the formatting fields from [Value Semantics](#value-semantics) (`semantics`, `badgeColors`, `link`).

```json
{ "id": "deals", "type": "data-table", "title": "Open deals",
  "src": "crm/open-deals.json", "pageSize": 25,
  "columns": [
    { "key": "name", "label": "Deal", "type": "text" },
    { "key": "value", "label": "Value", "type": "currency" },
    { "key": "stage", "label": "Stage", "type": "badge",
      "badgeColors": { "Discovery": "info", "Proposal": "warning", "Closing": "success" } }
  ],
  "rowAction": { "label": "Draft follow-up",
    "promptTemplate": "Draft a follow-up email for {{name}} ({{value}}) — they are at stage {{stage}}." } }
```

#### `chart` — the only component allowed to inline data

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `chartType` | Yes | `"bar"` \| `"line"` \| `"funnel"` \| `"pie"` | Closed enum |
| `categories` | Yes | 2–24 strings, each ≤ 60 chars | X axis / slice labels |
| `series` | Yes | 1–3 series | Each: `{ name ≤ 60, unit ≤ 12, values }` where `values` is 2–48 numbers **with the same length as `categories`** |
| `title` | No | string | |
| `goodWhen` | No | string | Reserved — not rendered yet, do not rely on it |

`pie` and `funnel` render only the first series. Because `chart` inlines its data, it counts against the 4 KB payload budget — a few dozen points is the practical ceiling. Bigger data: aggregate it, or link a `data-table` for the detail rows.

```json
{ "id": "growth", "type": "chart", "title": "Revenue by quarter", "chartType": "bar",
  "categories": ["Q1", "Q2", "Q3", "Q4"],
  "series": [ { "name": "Revenue", "unit": "M$", "values": [12, 15, 19, 24] } ] }
```

#### `alert` — info/success/warning/error banner

`severity` (`"info"` \| `"success"` \| `"warning"` \| `"error"`) and `message` are required; `title` optional.

#### `progress` — running/success/error indicator

`status` (`"running"` \| `"success"` \| `"error"`) and `label` are required; optional `percent` 0–100 (omit it for an indeterminate spinner). Reuse the same `id` across calls to animate a long task.

#### `action-buttons` — 1–6 buttons that act on the conversation

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `buttons` | Yes | 1–6 button objects | See below |
| `title` | No | string | |

Each button:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique within the component |
| `label` | Yes | Button text |
| `style` | No | `"primary"` \| `"secondary"` (default) \| `"danger"`. Use `primary` for the recommended action, `danger` for destructive ones |
| `confirm` | No | `{ message ≤ 300 }` — in-place confirmation bar before the action fires. Use for high-stakes actions |
| `params` | No | ≤ 8 inputs collected before sending: `{ key ≤ 40, label ≤ 60, type: "text"\|"number"\|"select", required, options ≤ 12 }` |
| `action` | Yes | Exactly one of: `{ "kind": "send-message", "prompt": "…" }` · `{ "kind": "send-message", "promptTemplate": "…{{key}}…" }` · `{ "kind": "fill-input", "text": "…" }` |

Rules:

- `send-message` sends the text as the **next user message**; `fill-input` only prefills the chat input for the user to edit.
- `params` requires `send-message` + `promptTemplate` (that is where the collected values land via `{{key}}`).
- `select` params must declare `options`; only `select` may.
- Template values are not re-interpolated into anything but the prompt — never hardcode row values you could template.

```json
{ "id": "triage", "type": "action-buttons", "title": "Triage this ticket",
  "buttons": [
    { "id": "assign", "label": "Assign engineer", "style": "primary",
      "params": [ { "key": "engineer", "label": "Engineer", "type": "select",
                    "options": ["Ada", "Grace", "Linus"], "required": true } ],
      "action": { "kind": "send-message", "promptTemplate": "Assign this ticket to {{engineer}} and draft a handoff note." } },
    { "id": "close", "label": "Close without reply", "style": "danger",
      "confirm": { "message": "Close this ticket without replying?" },
      "action": { "kind": "send-message", "prompt": "Close the ticket with a brief polite note." } },
    { "id": "draft", "label": "Draft a reply",
      "action": { "kind": "fill-input", "text": "Draft a reply to this ticket: " } }
  ] }
```

#### `form` — 1–12 fields the user fills

| Field | Required | Description |
|-------|----------|-------------|
| `fields` | Yes | 1–12 field objects: `{ key, label, type: "text"\|"number"\|"select"\|"date", required, options }`. `select` must declare 1–20 `options`; only `select` may. Keys unique within the form |
| `title` | No | |
| `submitLabel` | No | Submit button text |

Submitting **always** sends the collected values object as the next user message — there is no `action` field by design. Write your follow-up prompt so a raw `{key: value}` object is easy to act on.

```json
{ "id": "intake", "type": "form", "title": "New hire intake", "submitLabel": "Create onboarding plan",
  "fields": [
    { "key": "name", "label": "Full name", "required": true },
    { "key": "start", "label": "Start date", "type": "date", "required": true },
    { "key": "team", "label": "Team", "type": "select", "options": ["Platform", "Design", "Growth"] },
    { "key": "budget", "label": "Equipment budget", "type": "number" }
  ] }
```

> Components from a third-party component catalog render **read-only** in this phase — their descriptions are marked "(read-only)" and they accept no interaction. Do not promise clicks on them.

### Value Semantics

| Field | Where | Behavior |
|-------|-------|----------|
| `format: "percent"` | `stat-card`, percent columns | Input is a fraction: `0.093` → `9.3%` |
| `format: "currency"` | `stat-card`, currency columns | Thousands separators + `currency` prefix |
| `semantics` | percent columns | `"change"` (default) renders signed, colored (`+15.2%` green / `-3%` red); `"rate"` or `"share"` renders unsigned in a neutral color (a 92% success rate is not "good news green") |
| `badgeColors` | badge columns | Map column values to `info` \| `success` \| `warning` \| `error` |
| `link` | any column | Value is a URL, or `{ "value": …, "link": … }` — renders as an external link |
| `goodWhen` | `stat-card` | `"up"` (default) / `"down"` / `"neutral"` — flips delta coloring for inverse metrics (costs, churn) |

### Data Rules: Inline vs File-Backed

- The whole `render_ui` payload is capped at **4096 bytes**. Inlining rows or long arrays burns that budget fast and costs real tokens.
- **`data-table` never takes inline data**: write the JSON with `transform_data`, then point `"src"` at it. The path must resolve inside the session `data/` directory and the file must already exist.
- **`chart` is the only component that inlines data** (a few dozen points max). `action-buttons`, `form`, `alert`, `progress`, `stat-card` carry no datasets by design.

### Cross-Field Rules

| Rule | Detail |
|------|--------|
| Unique `id` | Per call, across all components. Duplicate → `[genui:duplicate-component-id]` |
| `id` reuse across calls | Same id = in-place update of that card |
| `chart` series length | Every series' `values` must have exactly `categories.length` entries |
| `form` select | `options` (1–20) required, and only allowed, on `type: "select"` |
| `action-buttons` params | `params` ⇒ `send-message` + `promptTemplate`; `select` ⇔ `options`; param keys unique per button |
| `confirm` | Only on `action-buttons` buttons; message ≤ 300 chars |

### Error Codes

Validation failures return one message listing every issue, each prefixed with a stable code:

| Code | Meaning |
|------|---------|
| `[genui:payload-too-large]` | Payload over 4096 bytes — move data to a file |
| `[genui:too-many-components]` | More than 8 components in one call |
| `[genui:duplicate-component-id]` | Two components share an `id` |
| `[genui:duplicate-form-field-key]` | Two form fields share a `key` |
| `[genui:select-options-mismatch]` | `select` without `options`, or `options` on a non-select |
| `[genui:missing-required]` | A required field is absent |
| `[genui:invalid-type]` | A value has the wrong type / is out of range |
| `[genui:unrecognized-key]` | Unknown key (payloads are strict — including `rows` on `data-table` or `src` on `chart`) |
| `[genui:schema-invalid]` | Anything else the schema rejects |

Fix the listed issues and retry **once**. If it fails again, fall back to a markdown block or plain text — do not loop.

## Canvas Apps (`generate_app`)

### Lifecycle

1. **Create** — call `generate_app` with `title` (1–120 chars) and a complete `html` document. The host writes it under the session's `data/genui-apps/<appId>/` directory and a card appears in the chat (320px inline). The tool result ends with a machine-readable marker (`[genui-app id="…" version="…" path="…"]`) — the UI uses it to mount the card.
2. **Iterate data** — call `update_app_data` with `appId`, `dataSrc` (a path declared in the HTML's `<meta name="polo-app-data">`), and `data` (any JSON, ≤ 1 MB). The mounted card re-renders immediately; nothing else changes.
3. **Iterate structure** — call `generate_app` again with `updateOf: <appId>`. This is a **full HTML rewrite**: send the complete document every time, the version increments, last write wins.
4. **Open in canvas** — the user can expand the card into the right-side canvas pane (see [Card Hosts](#card-hosts-in-the-chat)).
5. **Pin / Publish** — the user can pin the app as a tab or publish it to their organization. Both are user actions; never promise them in prose.

### HTML Contract

- **One complete HTML document, fully self-contained.** Inline CSS/JS. Hard limit **512 KB** per bundle.
- **No external resources.** `src`/`href`, `srcset`, CSS `url()` and `@import`, and runtime calls (`fetch`, `XMLHttpRequest` `.open`, `WebSocket`, `EventSource`, `sendBeacon`, dynamic `import`) may not reference `http(s)`/`ws(s)`. Use `data:` URIs for images and fonts (they are decoded and re-scanned one level, so no smuggling external URLs inside them). The only exempt string is the SVG `xmlns` namespace identifier on w3.org.
- **Never reference `@polo-ai/sdk`** in a session-generated app.
- The only sanctioned deep link is `poloai://action/ui-event/` (see [Host Bridge Events](#host-bridge-events-ui-event)). Any other `poloai://` link is rejected.
- SVG and inline `<script>` are fine. Everything runs in a sandboxed `<webview>` with `contextIsolation=yes, nodeIntegration=no, sandbox=yes` and a per-session ephemeral partition — there is **no network access at all**, unlike the `html-preview` iframe (which allows https images and CDN fonts).

### Mutable State: `polo-app-data`

Keep state **out of the HTML** so it can change without a rewrite:

```html
<meta name="polo-app-data" content="tip-splitter/state.json">
```

- The path is relative to the session `data/` directory, ≤ 1024 chars, and must resolve inside `data/` (no `..`, no symlinks out).
- At most **3 declared files per app**, each **≤ 1 MB**.
- The host reads declared files only, and pushes their content to the mounted card as a `ui_state` message on attach and after every `update_app_data` (a watcher re-pushes on external file changes, debounced ~1s). The card reads state from that message — it can never `fetch` the file (no network) and can never reach an undeclared path.
- `update_app_data` requires `dataSrc` to equal one of the declared paths.

### Host Bridge Events (`ui-event`)

The one channel for app → assistant communication:

- **Declare it**: `<meta name="polo-bridge-capabilities" content="ui-event">` in the attached document. Without the declaration every event is rejected (`capability_denied`).
- **Read your identity from the URL**: the host appends `?poloCard=<cardId>&poloSession=<sessionId>` to the file URL — parse them from `location.search` and put them into `cardId`/`sessionId`.
- **Send** by navigating: `location.href = "poloai://action/ui-event/" + sessionId + "?cardId=…&eventId=…&type=button-click|value-change|submit&callbackId=…"` plus exactly one of `payload` (URL-encoded JSON object, ≤ 8 KB) or `payloadSrc` (JSON file inside `data/`, ≤ 1 MB).
- **Receive** via `window.addEventListener("message", …)`: acks arrive as `{ type: "poloai:ack", callbackId, result: { sessionId, eventId } }`, pushed state as `{ type: "poloai:event", callbackId, event: { type: "ui_state", state, … } }`.
- **Reuse one `callbackId` for the whole card** — it pairs acks/errors; rotating it exhausts the host's per-page slots.
- Rate limit: **10 events per second per card**.
- Inside the payload JSON: `"modelContext"` is a short summary for the assistant (hard 2 KB cap, **silently truncated** — keep it tight; it is injected into the next turn's context, queue depth 8); `"privateState"` is any JSON echoed back only to your card via `ui_state`; other keys are ignored.

### Updating Apps

| Change | Tool | Why |
|--------|------|-----|
| Numbers, list contents, labels, any state | `update_app_data` | Small JSON write; mounted card re-renders instantly; HTML untouched |
| Layout, logic, new features | `generate_app` + `updateOf` | Full HTML rewrite; version increments |

Do not re-emit HTML to change data — it is slower, burns tokens, and resets nothing but costs a full validation pass.

## Card Hosts in the Chat

- **Inline card**: each app renders as a 320px card in the thread with its title and version badge. Repeated `generate_app` calls for the same app in one turn merge into a single card showing the latest content.
- **Canvas pane**: "Open in canvas" moves the app into a resizable right-side pane (25%–70% of the window, default 45%; drag the sash or use ←/→ in 2.5% steps). One app per pane — opening another replaces it. While the pane holds the app, the inline card collapses to a placeholder strip with a "Show in canvas" button (it flashes the pane for way-finding); closing the pane restores the inline card automatically. The card and the pane share the same bundle — there is never a second live copy.
- **Pinning**: "Pin to tabs" loads the app as a browser tab in the workspace. **Publishing**: "Publish" uploads the app as a web app artifact to the user's organization (disabled without an active organization; bundle layout must be `index.html` + optional `app.js`/`app.css`).

## Availability and Toggles

- These tools exist only in **interactive desktop sessions** — messaging, automation-spawned, and headless turns do not get them.
- Two switches gate them, both default-on: a remote capability flag (`generativeUI.inline` / `generativeUI.canvas`, absent = enabled) and the local **Settings → Tools** kill switches.
- If `render_ui` / `generate_app` are not in your tool list for a turn, they are unavailable — fall back to markdown blocks; do not mention the feature.

## Security Model

| Feature | Status | Details |
|---------|--------|---------|
| External network (canvas app) | **Blocked** | No http(s)/ws(s) resource, CDN, web font, image hotlink, or runtime request. `data:` URIs only |
| External network (cards) | **N/A** | Cards are declarative JSON; no code runs |
| Node/Electron APIs | **Blocked** | `contextIsolation=yes`, `nodeIntegration=no`, `sandbox=yes`, ephemeral per-session partition |
| Filesystem (canvas app) | **Fenced** | Reads only via declared `polo-app-data` paths; realpath-confined to the session `data/` directory; ≤ 3 files, ≤ 1 MB each |
| Assistant→app channel | **Fenced** | `update_app_data` writes declared paths only; content pushed as `ui_state`, never fetched by the app |
| App→assistant channel | **Fenced** | Only `poloai://action/ui-event/`, requires the `ui-event` capability meta; 10 events/s; `modelContext` ≤ 2 KB (truncated), `privateState` card-local |
| Cross-card leakage | **Blocked** | `ui_state` is addressed to one card; `privateState` returns only to the sender; channels die with the card |
| Data persistence | **Ephemeral** | `ui_state` is never persisted; files stay inside the session `data/` fence |

## Best Practices

### Decision Tree

```
Does the user need to ACT (decide, pick, fill, confirm)?
├─ Yes → can 1–8 declarative components express it?
│        ├─ Yes → render_ui  (action-buttons / form / data-table rowAction)
│        └─ No  → generate_app (real client-side logic needed)
├─ No → is it tabular data?
│        ├─ 20+ rows or needs sort/filter/export
│        │        → datatable/spreadsheet block + transform_data (data-tables.md)
│        └─ Needs per-row follow-ups → render_ui data-table with rowAction
├─ Is it a trend/share/funnel (≤24 categories, ≤3 series)?
│        → render_ui chart (inline) — link a data-table for row detail
├─ Is it rich HTML to LOOK at (email, report)?
│        → html-preview block (html-preview.md)
└─ Is it structure (flow, sequence, ER)?
         → Mermaid (mermaid.md)
```

### Sizing and Naming

- Keep `render_ui` payloads small: aggregate before charting, file-back anything tabular, put prose in the chat and only the decision on the card.
- Name app data paths after the app (`tip-splitter/state.json`), one purpose per file — you only get 3.
- Update cards in place with the same `id` instead of emitting new ones; a thread full of near-identical cards is noise.
- After a `render_ui` or `generate_app` validation error, fix and retry **once**, then degrade to a markdown block.

## Troubleshooting

### `[genui:payload-too-large]`
- Move tabular data out: `transform_data` → `data-table` with `"src"`.
- Aggregate or trim `chart` series (values are the usual offender).
- Split into two `render_ui` calls rather than shrinking labels.

### `data-table "src" must be within the session data directory`
- Use a path **relative to** the session `data/` directory (e.g. `crm/deals.json`), not an absolute path or `..` escape.
- The file must exist before `render_ui` — run `transform_data` first.

### `render_ui` returns `[genui:unrecognized-key]`
- Payloads are strict: no `rows` on `data-table`, no `src` on `chart`, no `action` on `form`, no `goodWhen` on `chart` (reserved).
- Check field names against the tables above — a typo'd key is reported, not ignored.

### Canvas app rejected for an external reference
- The error names the offending construct. Replace CDN links with inline CSS/JS, hotlinked images with `data:` URIs, and web fonts with system font stacks.
- Runtime references count too: no `fetch`/`XHR`/`WebSocket`/`EventSource`/`sendBeacon`, even to your own API.
- `data:` URIs are decoded and re-scanned — encoding an external URL inside one does not pass.

### `capability_denied` — ui-events never arrive
- The bundle must declare `<meta name="polo-bridge-capabilities" content="ui-event">` in the exact document that is attached. After a `generate_app` + `updateOf` rewrite, re-check the meta is still there.
- Confirm `cardId`/`sessionId` come from the host-appended `?poloCard=&poloSession=` query params, not from a guess.
- Keep one `callbackId` per card; a rotated id loses its ack channel.

### App shows stale data
- Data changes must go through `update_app_data` with a `dataSrc` that matches a declared `<meta name="polo-app-data">` path — writing the file some other way is not pushed.
- Structural changes need `generate_app` + `updateOf` (full HTML). If both were fine and it is still stale, re-send the data update; pushes are debounced ~1s.
