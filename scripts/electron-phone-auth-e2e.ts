import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const rootDirectory = join(import.meta.dir, '..')
const pol53SourceDirectory = process.env.POL53_WORKTREE?.trim()
  || '/Users/wow/project/z-h-ai/polo-admin-dir/POL-53/feat/phone-auth-registration'
const databaseBaseUrl = process.env.POL53_E2E_DATABASE_URL?.trim()
  || 'postgresql://postgres:postgres@localhost:5432/polo_admin_test'
const runId = randomBytes(6).toString('hex')
const databaseSchema = `polo_phone_auth_e2e_${runId}`
const databaseUrl = createIsolatedDatabaseUrl(databaseBaseUrl, databaseSchema)
const providerPort = await resolveE2ePort(process.env.POL53_E2E_PROVIDER_PORT)
const adminPort = await resolveE2ePort(
  process.env.POL53_E2E_ADMIN_PORT,
  new Set([providerPort]),
)
const providerBaseUrl = `http://127.0.0.1:${providerPort}`
const adminBaseUrl = `http://127.0.0.1:${adminPort}`
const bearerToken = randomBytes(32).toString('base64url')
const phone = `139${randomBytes(4).readUInt32BE(0).toString().padStart(10, '0').slice(0, 8)}`
const legacyIdentifier = `legacy_e2e_${randomBytes(6).toString('hex')}`
const legacyPassword = `legacy-password-${randomBytes(12).toString('base64url')}`
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
let pol53DatabaseReady = false
let e2eCompleted = false

function createIsolatedDatabaseUrl(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set('schema', schema)
  return url.toString()
}

async function resolveE2ePort(
  configuredPort: string | undefined,
  excluded = new Set<number>(),
): Promise<number> {
  if (configuredPort?.trim()) {
    return Number(configuredPort)
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.unref()
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          reject(new Error('Failed to allocate an E2E loopback port'))
          return
        }
        server.close(error => error ? reject(error) : resolve(address.port))
      })
    })
    if (!excluded.has(port)) return port
  }

  throw new Error('Failed to allocate distinct E2E loopback ports')
}

function validateSafetyBoundaries(): void {
  const url = new URL(databaseUrl)
  const databaseName = url.pathname.replace(/^\//, '')
  const schema = url.searchParams.get('schema')
  const loopback = (
    url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
  )
  if (
    !loopback
    || databaseName !== 'polo_admin_test'
    || schema !== databaseSchema
    || !/^polo_phone_auth_e2e_[a-f0-9]{12}$/.test(schema)
  ) {
    throw new Error(
      `Refusing Electron phone-auth E2E database ${url.hostname}/${databaseName}/${schema ?? ''}`,
    )
  }
  for (const port of [providerPort, adminPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('POL-53 E2E ports must be valid TCP ports')
    }
  }
  if (providerPort === adminPort) {
    throw new Error('POL-53 E2E provider and Admin ports must be distinct')
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

function createLegacyUser(): void {
  runChecked([
    'node',
    '-e',
    `
      const { PrismaClient } = require('@prisma/client');
      const argon2 = require('argon2');
      const prisma = new PrismaClient();
      const username = process.argv[1];
      const password = process.argv[2];
      argon2.hash(password, { type: argon2.argon2id })
        .then((passwordHash) => prisma.user.create({
          data: {
            username,
            passwordHash,
            displayName: 'Legacy Username E2E',
            role: 'user',
            status: 'active',
          },
        }))
        .finally(() => prisma.$disconnect());
    `,
    legacyIdentifier,
    legacyPassword,
  ], pol53Directory, { DATABASE_URL: databaseUrl })
}

function dropIsolatedDatabaseSchema(): void {
  const cleanupUrl = new URL(databaseUrl)
  cleanupUrl.searchParams.set('schema', 'public')
  runChecked([
    'node',
    '-e',
    `
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();
      const schema = process.argv[1];
      if (!/^polo_phone_auth_e2e_[a-f0-9]{12}$/.test(schema)) {
        throw new Error('Refusing to drop an unexpected E2E schema');
      }
      prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE')
        .finally(() => prisma.$disconnect());
    `,
    databaseSchema,
  ], pol53Directory, { DATABASE_URL: cleanupUrl.toString() })
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
      const legacyUsername = process.argv[4];

      async function actionCountsFor(userId) {
        const actions = await prisma.adminAuditLog.groupBy({
          by: ['action'],
          where: { targetUserId: userId },
          _count: { _all: true },
        });
        return Object.fromEntries(
          actions.map((entry) => [entry.action, entry._count._all]),
        );
      }

      async function cleanup() {
        const [phoneUser, legacyUser] = await Promise.all([
          prisma.user.findUnique({
            where: { phone: normalizedPhone },
            select: { id: true },
          }),
          prisma.user.findUnique({
            where: { username: legacyUsername },
            select: { id: true },
          }),
        ]);
        const [phoneActions, legacyActions, phoneSessions, legacySessions] =
          await Promise.all([
            phoneUser ? actionCountsFor(phoneUser.id) : {},
            legacyUser ? actionCountsFor(legacyUser.id) : {},
            phoneUser
              ? prisma.session.findMany({
                  where: { userId: phoneUser.id, deviceInfo: marker },
                  select: { revoked: true, revokedAt: true },
                })
              : [],
            legacyUser
              ? prisma.session.findMany({
                  where: { userId: legacyUser.id, deviceInfo: marker },
                  select: { revoked: true, revokedAt: true },
                })
              : [],
          ]);
        if (
          requireEvidence
          && (
            !phoneUser
            || !legacyUser
            || !phoneActions.phone_auth_registration
            || !phoneActions.phone_auth_login_success
            || !phoneActions.set_password
            || phoneActions.logout !== 3
            || !legacyActions.login_success
            || legacyActions.logout !== 1
            || phoneSessions.length !== 3
            || phoneSessions.some((session) => !session.revoked || !session.revokedAt)
            || legacySessions.length !== 1
            || legacySessions.some((session) => !session.revoked || !session.revokedAt)
          )
        ) {
          throw new Error(
            'Missing POL-53 logout/session/audit evidence: '
            + JSON.stringify({
              phoneActions,
              legacyActions,
              phoneSessions,
              legacySessions,
            }),
          );
        }

        const result = await prisma.$transaction(async (tx) => {
          async function deleteTargetUser(user, uniqueWhere) {
            if (!user) return { user: 0, sessions: 0, audits: 0 };
            const audits = (await tx.adminAuditLog.deleteMany({
              where: {
                OR: [
                  { targetUserId: user.id },
                  { adminUserId: user.id },
                ],
              },
            })).count;
            const sessions = (await tx.session.deleteMany({
              where: { userId: user.id },
            })).count;
            await tx.usageRecord.deleteMany({ where: { userId: user.id } });
            await tx.quotaPeriod.deleteMany({ where: { userId: user.id } });
            await tx.userGroup.deleteMany({ where: { userId: user.id } });
            await tx.userLlmConfig.deleteMany({ where: { userId: user.id } });
            const deletedUser = (await tx.user.deleteMany({
              where: { id: user.id, ...uniqueWhere },
            })).count;
            return { user: deletedUser, sessions, audits };
          }

          const phoneCleanup = await deleteTargetUser(
            phoneUser,
            { phone: normalizedPhone },
          );
          const legacyCleanup = await deleteTargetUser(
            legacyUser,
            { username: legacyUsername },
          );
          const deletedCodes = (await tx.phoneVerificationCode.deleteMany({
            where: { phone: { in: [phone, normalizedPhone] } },
          })).count;
          return {
            phoneCleanup,
            legacyCleanup,
            deletedCodes,
          };
        });

        const [
          remainingPhoneUser,
          remainingLegacyUser,
          remainingCodes,
          remainingMarkerSessions,
        ] =
          await Promise.all([
            prisma.user.count({ where: { phone: normalizedPhone } }),
            prisma.user.count({ where: { username: legacyUsername } }),
            prisma.phoneVerificationCode.count({
              where: { phone: { in: [phone, normalizedPhone] } },
            }),
            prisma.session.count({ where: { deviceInfo: marker } }),
          ]);
        if (
          remainingPhoneUser
          || remainingLegacyUser
          || remainingCodes
          || remainingMarkerSessions
        ) {
          throw new Error('POL-53 E2E cleanup left targeted records behind');
        }
        process.stdout.write(JSON.stringify({
          event: 'pol53_e2e_cleanup',
          phone,
          legacyUsername,
          ...result,
          remainingPhoneUser,
          remainingLegacyUser,
          remainingCodes,
          remainingMarkerSessions,
          evidence: {
            phoneActions,
            legacyActions,
            phoneSessionCount: phoneSessions.length,
            legacySessionCount: legacySessions.length,
            allSessionsRevoked: [...phoneSessions, ...legacySessions]
              .every((session) => session.revoked && session.revokedAt),
          },
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
    legacyIdentifier,
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
  const containsRequiredContract = Bun.spawnSync([
    'git',
    'merge-base',
    '--is-ancestor',
    '6e6455a',
    'HEAD',
  ], {
    cwd: pol53SourceDirectory,
  }).exitCode === 0
  if (!pol53Head || !containsRequiredContract) {
    throw new Error(
      `Expected POL-53 HEAD to contain contract 6e6455a, received ${pol53Head || 'unknown'}`,
    )
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

  runChecked([
    join(pol53Directory, 'node_modules', '.bin', 'prisma'),
    'migrate',
    'deploy',
  ], pol53Directory, {
    DATABASE_URL: databaseUrl,
  })
  pol53DatabaseReady = true
  runChecked(['npm', 'run', 'db:seed-test'], pol53Directory, {
    DATABASE_URL: databaseUrl,
  })
  cleanupPol53Run(false)
  createLegacyUser()

  pol53Runner = Bun.spawn([
    join(pol53Directory, 'node_modules', '.bin', 'tsx'),
    'scripts/run-phone-auth-e2e.ts',
  ], {
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
    legacyIdentifier,
    legacyPassword,
    adminBaseUrl,
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
  try {
    if (pol53DatabaseReady) cleanupPol53Run(e2eCompleted)
  } finally {
    try {
      if (pol53CloneReady) dropIsolatedDatabaseSchema()
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true })
    }
  }
}
