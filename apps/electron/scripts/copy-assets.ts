/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

/**
 * DEPRECATED SIDECAR PRUNE: the session MCP sidecar was removed from the
 * product (POO-53), but the resource copies below are OVERWRITE-only — a
 * leftover from a pre-removal build would survive staging and get packaged
 * via the dist resources glob in electron-builder. Both the source staging
 * directory and the dist copy are removed explicitly on every build.
 */
export function pruneDeprecatedSessionSidecar(electronDir: string): void {
  rmSync(join(electronDir, 'resources', 'session-mcp-server'), { recursive: true, force: true });
  rmSync(join(electronDir, 'dist', 'resources', 'session-mcp-server'), { recursive: true, force: true });
}

/**
 * Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
 * from `<electronDir>/resources` to `<electronDir>/dist/resources`.
 */
export function stageResources(electronDir: string = process.cwd()): void {
  pruneDeprecatedSessionSidecar(electronDir);
  mkdirSync(join(electronDir, 'dist'), { recursive: true });
  cpSync(join(electronDir, 'resources'), join(electronDir, 'dist', 'resources'), { recursive: true });

  console.log('✓ Copied resources/ → dist/resources/');

  // Copy PowerShell parser script (for Windows command validation in Explore mode)
  // Source: packages/shared/src/agent/powershell-parser.ps1
  // Destination: dist/resources/powershell-parser.ps1
  const psParserSrc = join(electronDir, '..', '..', 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
  const psParserDest = join(electronDir, 'dist', 'resources', 'powershell-parser.ps1');
  try {
    copyFileSync(psParserSrc, psParserDest);
    console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
  } catch {
    // Only warn - PowerShell validation is optional on non-Windows platforms
    console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
  }
}

if (import.meta.main) {
  if (!existsSync('resources')) {
    console.error('✗ resources/ not found — run from apps/electron');
    process.exit(1);
  }
  stageResources(process.cwd());
}
