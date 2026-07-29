import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const rootDirectory = join(import.meta.dir, '..')
const pol53SourceDirectory = process.env.POL53_WORKTREE?.trim()
  || '/Users/wow/project/z-h-ai/polo-admin-dir/POL-53/feat/phone-auth-registration'
const databaseUrl = process.env.POL53_E2E_DATABASE_URL?.trim()
  || 'postgresql://postgres:postgres@localhost:5432/polo_admin_test'
const providerPort = Number(process.env.POL53_E2E_PROVIDER_PORT || 39053)
const adminPort = Number(process.env.POL53_E2E_ADMIN_PORT || 39054)
const providerBaseUrl = `http://127.0.0.1:${providerPort}`
const adminBaseUrl = `http://127.0.0.1:${adminPort}`
const bearerToken = randomBytes(32).toString('base64url')
const phone = `139${randomBytes(4).readUInt32BE(0).toString().padStart(10, '0').slice(0, 8)}`
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'polo-phone-auth-e2e-'))
const pol53Directory = join(temporaryDirectory, 'pol53')
const configDirectory = join(temporaryDirectory, 'config')
const mainOutput = join(temporaryDirectory, 'main.cjs')
const preloadOutput = join(temporaryDirectory, 'bootstrap-preload.cjs')
const rendererHtml = join(
  rootDirectory,
  'apps/electron/dist/renderer/index.html',
)
const electronExecutable = require('electron') as string
let pol53Runner: ReturnType<typeof Bun.spawn> | undefined
let pol53CloneReady = false
let e2eCompleted = false
let aliceLastLoginAtBeforeRun: string | null = null

function validateSafetyBoundaries(): void {
  const url = new URL(databaseUrl)
  const databaseName = url.pathname.replace(/^\//, '')
  const loopback = (
    url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
  )
  if (!loopback || databaseName !== 'polo_admin_test') {
    throw new Error(
      `Refusing Electron phone-auth E2E database ${url.hostname}/${databaseName}`,
    )
  }
  for (const port of [providerPort, adminPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('POL-53 E2E ports must be valid TCP ports')
    }
  }
}

function runChecked(command: string[], cwd: string, env?: Record<string, string>): void {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stderr: 'inherit',
    stdout: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${command.join(' ')}`)
  }
}

function runCaptured(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stderr: 'inherit',
    stdout: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${command.join(' ')}`)
  }
  return result.stdout.toString().trim()
}

function captureAliceBaseline(): string | null {
  const output = runCaptured([
    'node',
    '-e',
    `
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      prisma.user.findUnique({
        where: { username: 'alice' },
        select: { lastLoginAt: true },
      }).then((user) => {
        process.stdout.write(JSON.stringify({
          lastLoginAt: user?.lastLoginAt?.toISOString() ?? null,
        }));
      }).finally(() => prisma.$disconnect());
    `,
  ], pol53Directory, { DATABASE_URL: databaseUrl })
  return (JSON.parse(output) as { lastLoginAt: string | null }).lastLoginAt
}

function cleanupPol53Run(requireEvidence: boolean): void {
  const output = runCaptured([
    'node',
    '-e',
    `
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      const phone = process.argv[1];
      const normalizedPhone = phone.startsWith('+') ? phone : '+86' + phone;
      const marker = process.argv[2];
      const requireEvidence = process.argv[3] === 'true';
      const baselineLastLoginAt = process.argv[4] === 'null'
        ? null
        : new Date(process.argv[4]);

      async function cleanup() {
        const user = await prisma.user.findUnique({
          where: { phone: normalizedPhone },
          select: { id: true },
        });
        const actions = user
          ? await prisma.adminAuditLog.groupBy({
              by: ['action'],
              where: { targetUserId: user.id },
              _count: { _all: true },
            })
          : [];
        const actionCounts = Object.fromEntries(
          actions.map((entry) => [entry.action, entry._count._all]),
        );
        if (
          requireEvidence
          && (
            !user
            || !actionCounts.phone_auth_registration
            || !actionCounts.phone_auth_login_success
            || !actionCounts.set_password
          )
        ) {
          throw new Error(
            'Missing POL-53 registration/login/password audit evidence: '
            + JSON.stringify(actionCounts),
          );
        }

        const result = await prisma.$transaction(async (tx) => {
          let deletedRandomUser = 0;
          if (user) {
            await tx.adminAuditLog.deleteMany({
              where: {
                OR: [
                  { targetUserId: user.id },
                  { adminUserId: user.id },
                ],
              },
            });
            await tx.session.deleteMany({ where: { userId: user.id } });
            await tx.usageRecord.deleteMany({ where: { userId: user.id } });
            await tx.quotaPeriod.deleteMany({ where: { userId: user.id } });
            await tx.userGroup.deleteMany({ where: { userId: user.id } });
            await tx.userLlmConfig.deleteMany({ where: { userId: user.id } });
            deletedRandomUser = (await tx.user.deleteMany({
              where: { id: user.id, phone: normalizedPhone },
            })).count;
          }

          const deletedCodes = (await tx.phoneVerificationCode.deleteMany({
            where: { phone: { in: [phone, normalizedPhone] } },
          })).count;
          const alice = await tx.user.findUnique({
            where: { username: 'alice' },
            select: { id: true },
          });
          let deletedLegacySessions = 0;
          let deletedLegacyAudits = 0;
          if (alice) {
            deletedLegacySessions = (await tx.session.deleteMany({
              where: { userId: alice.id, deviceInfo: marker },
            })).count;
            deletedLegacyAudits = (await tx.adminAuditLog.deleteMany({
              where: {
                targetUserId: alice.id,
                action: 'login_success',
                detail: {
                  path: ['deviceInfo'],
                  equals: marker,
                },
              },
            })).count;
            await tx.user.update({
              where: { id: alice.id },
              data: { lastLoginAt: baselineLastLoginAt },
            });
          }
          return {
            deletedRandomUser,
            deletedCodes,
            deletedLegacySessions,
            deletedLegacyAudits,
          };
        });

        const [remainingUser, remainingCodes, remainingMarkerSessions] =
          await Promise.all([
            prisma.user.count({ where: { phone: normalizedPhone } }),
            prisma.phoneVerificationCode.count({
              where: { phone: { in: [phone, normalizedPhone] } },
            }),
            prisma.session.count({ where: { deviceInfo: marker } }),
          ]);
        if (remainingUser || remainingCodes || remainingMarkerSessions) {
          throw new Error('POL-53 E2E cleanup left targeted records behind');
        }
        process.stdout.write(JSON.stringify({
          event: 'pol53_e2e_cleanup',
          phone,
          ...result,
          remainingUser,
          remainingCodes,
          remainingMarkerSessions,
          evidence: actionCounts,
        }));
      }

      cleanup()
        .finally(() => prisma.$disconnect())
        .catch((error) => {
          console.error(error);
          process.exit(1);
        });
    `,
    phone,
    `polo-phone-auth-e2e/${phone}`,
    String(requireEvidence),
    aliceLastLoginAtBeforeRun ?? 'null',
  ], pol53Directory, { DATABASE_URL: databaseUrl })
  console.log(output)
}

async function waitForPol53(): Promise<void> {
  const discoveryUrl = `${adminBaseUrl}/api/auth/phone/challenge/config`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (pol53Runner?.exitCode !== null) {
      throw new Error(`POL-53 runner exited early with ${pol53Runner.exitCode}`)
    }
    try {
      const response = await fetch(discoveryUrl)
      if (response.ok) {
        const body = await response.json() as { type?: string; issuerUrl?: string }
        if (
          body.type === 'browser_redirect'
          && body.issuerUrl === `${providerBaseUrl}/challenge`
        ) {
          console.log(JSON.stringify({
            event: 'pol53_ready',
            database: 'polo_admin_test',
            discoveryUrl,
            issuerUrl: body.issuerUrl,
          }))
          return
        }
      }
    } catch {
      // The real Next.js service may still be compiling its first route.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for the POL-53 discovery endpoint')
}

async function buildElectronFixture(): Promise<void> {
  const workspaceDirectory = join(configDirectory, 'workspace')
  mkdirSync(configDirectory, { recursive: true })
  mkdirSync(workspaceDirectory, { recursive: true })
  writeFileSync(join(configDirectory, 'config.json'), JSON.stringify({
    workspaces: [{
      id: 'phone-auth-e2e-workspace',
      name: 'Phone Auth E2E',
      slug: 'phone-auth-e2e',
      rootPath: workspaceDirectory,
      createdAt: Date.now(),
    }],
    activeWorkspaceId: 'phone-auth-e2e-workspace',
    activeSessionId: null,
    adminUrl: adminBaseUrl,
  }, null, 2))

  // Build and load the real Vite Renderer entry. No E2E Renderer harness is
  // generated or mounted.
  runChecked(['bun', 'run', 'electron:build:renderer'], rootDirectory)
  if (!existsSync(rendererHtml)) {
    throw new Error(`Production Renderer build is missing: ${rendererHtml}`)
  }

  await Promise.all([
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      entryPoints: ['apps/electron/e2e/phone-auth/main.ts'],
      external: ['electron'],
      format: 'cjs',
      outfile: mainOutput,
      platform: 'node',
    }),
    build({
      absWorkingDir: rootDirectory,
      bundle: true,
      define: {
        __POLO_AI_TRUSTED_PHONE_AUTH_E2E__: 'true',
      },
      entryPoints: ['apps/electron/src/preload/bootstrap.ts'],
      external: ['electron'],
      format: 'cjs',
      outfile: preloadOutput,
      platform: 'node',
    }),
  ])
}

async function main(): Promise<void> {
  validateSafetyBoundaries()
  const pol53Head = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
    cwd: pol53SourceDirectory,
  }).stdout.toString().trim()
  if (pol53Head !== '6e6455a') {
    throw new Error(`Expected POL-53 HEAD 6e6455a, received ${pol53Head || 'unknown'}`)
  }

  // Run the upstream service from an isolated local clone. Next.js rewrites
  // next-env.d.ts during startup, so executing inside the dependency worktree
  // would violate the read-only boundary even if the file were restored later.
  runChecked([
    'git',
    'clone',
    '--local',
    '--no-hardlinks',
    '--no-checkout',
    pol53SourceDirectory,
    pol53Directory,
  ], temporaryDirectory)
  runChecked(['git', 'checkout', '--detach', pol53Head], pol53Directory)
  runChecked([
    'cp',
    '-cR',
    join(pol53SourceDirectory, 'node_modules'),
    join(pol53Directory, 'node_modules'),
  ], temporaryDirectory)
  pol53CloneReady = true

  runChecked(['npm', 'run', 'db:seed-test'], pol53Directory, {
    DATABASE_URL: databaseUrl,
  })
  aliceLastLoginAtBeforeRun = captureAliceBaseline()
  cleanupPol53Run(false)

  pol53Runner = Bun.spawn(['npm', 'run', 'dev:phone-auth-e2e'], {
    cwd: pol53Directory,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PHONE_AUTH_E2E_BEARER_TOKEN: bearerToken,
      PHONE_AUTH_E2E_PROVIDER_PORT: String(providerPort),
      PHONE_AUTH_E2E_ADMIN_PORT: String(adminPort),
    },
    stderr: 'inherit',
    stdout: 'inherit',
  })

  await waitForPol53()
  await buildElectronFixture()

  const electron = Bun.spawn([
    electronExecutable,
    mainOutput,
    preloadOutput,
    rendererHtml,
    providerBaseUrl,
    bearerToken,
    phone,
  ], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      POLO_AI_CONFIG_DIR: configDirectory,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await electron.exited
  if (exitCode !== 0) {
    throw new Error(`Native Electron phone auth E2E exited with ${exitCode}`)
  }
  e2eCompleted = true
}

try {
  await main()
} finally {
  pol53Runner?.kill('SIGTERM')
  if (pol53Runner) await pol53Runner.exited
  if (pol53CloneReady) cleanupPol53Run(e2eCompleted)
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
