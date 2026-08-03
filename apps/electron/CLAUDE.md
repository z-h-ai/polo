# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`@polo-ai/electron` — the cross-platform Electron desktop app for Polo AI. React + Jotai renderer, WebSocket RPC transport to a local or remote session server, esbuild-bundled main process.

## Commands

All commands run from the **monorepo root** (`../../` from here):

```bash
# Development
bun run electron:dev              # Vite HMR dev mode (renderer on :5173)
bun run electron:dev:menu         # Dev with terminal menu manager
bun run electron:start            # Full build + run

# Build
bun run electron:build            # main + preload + renderer + resources + assets
bun run electron:build:main       # esbuild: src/main → dist/main.cjs
bun run electron:build:preload    # esbuild: preload scripts → dist/*-preload.cjs
bun run electron:build:renderer   # Vite: React app → dist/renderer/

# Lint & typecheck
bun run lint:electron             # ESLint (from root)
cd apps/electron && bun run lint  # ESLint (from here)
cd apps/electron && bun run typecheck  # tsc --noEmit

# Tests (bun:test)
bun test                          # All tests across monorepo
bun test src/transport/__tests__/ws-rpc.test.ts  # Single test file

# Distribution
bun run electron:dist:mac         # macOS DMG (arm64)
bun run electron:dist:win         # Windows NSIS installer
bun run electron:dist:dev:mac     # Dev-signed macOS (no notarization)
```

## Architecture

### Process Model

- **Main process** (`src/main/index.ts`) — window lifecycle, IPC, OAuth flows, file dialogs, auto-update, Sentry. Bootstraps a local RPC server via `@polo-ai/server-core`.
- **Preload** (`src/preload/bootstrap.ts`) — context bridge exposing `window.electronAPI` (RPC client, file ops, dialogs). A second preload (`browser-toolbar.ts`) serves embedded browser windows.
- **Renderer** (`src/renderer/`) — React app. Entry at `main.tsx`, root component at `App.tsx`.
- **Transport** (`src/transport/`) — `RoutedClient` wraps a local `WsRpcClient` + optional remote workspace client. Routes `LOCAL_ONLY` channels locally, everything else to the workspace server. `channel-map.ts` defines the channel routing table.

### Renderer State (Jotai)

Atoms in `src/renderer/atoms/` provide per-session isolation via atom families:

- `sessionAtomFamily(id)` — full session + messages
- `sessionMetaMapAtom` — lightweight metadata for list rendering (avoids loading all messages)
- `sourcesAtom`, `skillsAtom`, `browserPaneAtom`, `automationsAtom`, `messagingAtom`, `panelStackAtom`, `overlayAtom`

Jotai HMR is configured via Babel plugins in `vite.config.ts` — atom instances survive module re-execution.

### Event Processing

`src/renderer/event-processor/` is a pure-function pipeline: `processEvent(state, event) → ProcessResult`. Handlers in `handlers/` subdirectory cover text streaming, tool lifecycle, and session metadata updates. Always returns new references (Jotai depends on this).

### Action Registry

`src/renderer/actions/` — centralized keyboard shortcut system. ESLint forbids importing `react-hotkeys-hook` directly; all shortcuts go through `useAction()`.

### Navigation

Type-safe routing via `src/renderer/lib/navigate.ts` and `src/shared/routes.ts`. Deep links use `poloai://` scheme. ESLint rule `no-direct-navigation-state` enforces using `navigate()`.

## Monorepo Context

```
packages/core/       — Type-only layer (see packages/core/CLAUDE.md)
packages/shared/     — Business logic: agents, sessions, config, credentials, i18n (see packages/shared/CLAUDE.md)
packages/server-core/ — RPC server, session manager, transport
packages/ui/         — Shared Radix + Tailwind component library
apps/electron/       — This directory
apps/webui/          — Web thin client
```

## Custom ESLint Rules

`eslint-rules/` enforces architectural boundaries (all are `error` severity unless noted):

| Rule | Enforces |
|------|----------|
| `no-direct-navigation-state` | Use `navigate()`, not raw state mutation |
| `no-localstorage` (warn) | Persist via config files, not localStorage |
| `no-direct-platform-check` | Use `getPlatform()` from context, not `process.platform` |
| `no-hardcoded-path-separator` (warn) | Use `path.join()`, not `/` or `\` |
| `no-direct-file-open` | Use `onOpenFile` from AppShellContext for in-app previews |
| `no-inline-source-auth-check` | Use `isSourceUsable()` helper |
| `no-hardcoded-z-index` | Use CSS variable tokens (`var(--z-*)`) or Tailwind `z-*` |
| `no-nonstandard-shadows` | Approved shadow classes only (shadow-xs, shadow-tinted, etc.) |

Additionally, `no-restricted-imports` blocks:
- `react-hotkeys-hook` → use action registry
- Provider SDKs in `src/main/` → use `@z-h-ai/shared/agent/backend` abstraction
- Direct `fetch` / SDK imports in `src/main/model-fetchers/` → delegate to backend APIs

## Build Notes

- Main process is bundled with **esbuild** → `dist/main.cjs`. Only `electron` is externalized; the Claude Agent SDK is bundled (see README.md §1 for path resolution gotcha).
- Renderer is bundled with **Vite** (React + Tailwind). Multiple entry points: `index.html`, `playground.html`, `browser-toolbar.html`, `browser-empty-state.html`.
- OAuth secrets are baked in at build time via esbuild `--define` flags, sourced from `.env` (gitignored, synced from 1Password via `bun run sync-secrets`).
- React is aliased to root `node_modules/react` in Vite config to avoid duplicate-React errors from `@polo-ai/ui`.

## Path Aliases

```
@/*          → src/renderer/*
@config/*    → ../../packages/shared/src/config/*
@z-h-ai/shared → ../../packages/shared/src/index.ts
```

## i18n

All user-facing strings use `t()` (React) or `i18n.t()` (non-React). Translation files live in `packages/shared/src/i18n/locales/{lang}.json`. Never call `i18n.t()` at module level — only inside functions. See `packages/shared/CLAUDE.md` for full i18n conventions.
