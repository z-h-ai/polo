/**
 * Shared build entry for the pi-agent-server production bundle.
 *
 * Single runnable consumer of the testable staging core
 * (scripts/build/pi-agent-server-staging.ts, which itself sources the build
 * args from pi-build-args.ts): the package build script
 * (packages/pi-agent-server `bun run build`), the Docker server image and
 * any other non-TS caller route through here so no target/format definition
 * is ever duplicated.
 */

import { join } from 'node:path'
import { buildPiAgentServerBundle } from './pi-agent-server-staging.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')

try {
  await buildPiAgentServerBundle({
    sourceEntry: join(REPO_ROOT, 'packages', 'pi-agent-server', 'src', 'index.ts'),
    distDir: join(REPO_ROOT, 'packages', 'pi-agent-server', 'dist'),
  }, REPO_ROOT)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
