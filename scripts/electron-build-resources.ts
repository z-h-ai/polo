/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync } from "fs";
import { join } from "path";
import { pruneDeprecatedSessionSidecar } from "../apps/electron/scripts/copy-assets.ts";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

if (existsSync(srcDir)) {
  // DEPRECATED SIDECAR PRUNE: the session MCP sidecar was removed from the
  // product — never let a pre-removal leftover survive into dist (the copies
  // below are overwrite-only). Single prune implementation lives in the
  // asset staging script.
  pruneDeprecatedSessionSidecar(ELECTRON_DIR);
  cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log("📦 Copied resources to dist");
} else {
  console.log("⚠️ No resources directory found");
}
