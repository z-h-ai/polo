/**
 * Bundled Skills Resolution
 *
 * Skills shipped inside the app live under the bundled assets directory
 * (apps/electron/resources/builtin-skills/) and are read in place — they are
 * never copied to the user's home and are never installed into a workspace.
 * This module only resolves the root; the loading itself reuses the shared
 * tier loaders in storage.ts so bundled, global, workspace and project skills
 * stay one composition rule.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { getBundledAssetsRoot } from '../utils/paths.ts';

/** Directory below the bundled assets root that holds app-shipped skills. */
export const BUNDLED_SKILLS_ASSET_DIRNAME = 'builtin-skills';

/**
 * Resolve the bundled skills root for the current runtime layout.
 *
 * Follows the getBundledAssetsDir candidate order (packaged assets root first,
 * then dev candidates), with one builtin-skills-specific addition: in a
 * monorepo dev checkout the source resources directory outranks the staged
 * dist/resources copy, because it is the editing source of truth while the
 * staging copy can be stale.
 *
 * Returns undefined when the runtime ships without bundled skills.
 */
export function getBundledSkillsRoot(): string | undefined {
  const assetsRoot = getBundledAssetsRoot();
  const candidates = [
    // Packaged app (registered at startup) or an injected fixture root.
    ...(assetsRoot ? [join(assetsRoot, 'resources', BUNDLED_SKILLS_ASSET_DIRNAME)] : []),
    // Monorepo dev checkout: source of truth before any staged copy.
    join(process.cwd(), 'apps', 'electron', 'resources', BUNDLED_SKILLS_ASSET_DIRNAME),
    // Dev run from apps/electron, then the staged dist copy.
    join(process.cwd(), 'resources', BUNDLED_SKILLS_ASSET_DIRNAME),
    join(process.cwd(), 'dist', 'resources', BUNDLED_SKILLS_ASSET_DIRNAME),
  ];
  return candidates.find(candidate => existsSync(candidate));
}
