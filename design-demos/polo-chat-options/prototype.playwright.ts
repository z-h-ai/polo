import { test, expect } from "@playwright/test";

// This spec targets the Playwright runner exclusively. The file name
// (`*.playwright.ts`) is deliberately outside bun test's default discovery
// globs (`*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`) so `bun test` never
// loads it in environments where `@playwright/test` is not installed; this
// config collects it explicitly via `bunx playwright test`.

const base = "http://127.0.0.1:8765/design-demos/polo-chat-options";
const screenshotDir = "/Users/wow/project/z-h-ai/polo-dir/POO-50/feature/polo-chat-options/design-demos/polo-chat-options/screenshots";

test.use({ channel: "chrome" });