#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { parseDraftReleaseIdentity } from './electron-release-draft-identity'
import { pullRelease, type ReleasePullOptions } from './polo-release-pull'
import { parseStrictSemverTag } from './strict-semver'

const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const JOB_STATUS_PREFIX = 'POLO_RELEASE_JOB_STATUS='

export type ReleaseJobStatus = 'running' | 'success' | 'failed' | 'cancelled'

export interface ReleaseJobRequest {
  repository: string
  tag: string
  version: string
  commitSha: string
  releaseId: number
  assetIdentity: string
}

interface ReleaseJobState {
  status: ReleaseJobStatus
  requestHash: string
  attemptId: string
  pid: number
  updatedAt: string
}

interface ReleaseJobControllerOptions {
  releasesDir?: string
  spawnWorker?: (args: string[], logPath: string) => number
  processAlive?: (pid: number) => boolean
  terminateProcess?: (pid: number) => Promise<void>
  pull?: (options: ReleasePullOptions) => Promise<'published' | 'idempotent'>
}

function required(values: Record<string, string | undefined>, key: string): string {
  const value = values[key]
  if (!value) throw new Error(`Missing --${key}`)
  return value
}

export function normalizeReleaseJobRequest(input: ReleaseJobRequest): ReleaseJobRequest {
  if (!REPOSITORY_PATTERN.test(input.repository)) throw new Error('Repository is invalid')
  if (parseStrictSemverTag(input.tag) !== input.version) {
    throw new Error('Tag and strict SemVer version do not match')
  }
  const commitSha = input.commitSha.toLowerCase()
  if (!COMMIT_PATTERN.test(commitSha)) throw new Error('Commit SHA is invalid')
  if (!Number.isSafeInteger(input.releaseId) || input.releaseId <= 0) {
    throw new Error('Approved Draft Release ID is invalid')
  }
  const identity = parseDraftReleaseIdentity(JSON.parse(input.assetIdentity))
  if (identity.releaseId !== input.releaseId) {
    throw new Error('Approved Draft Release ID does not match its asset identity')
  }
  return {
    repository: input.repository,
    tag: input.tag,
    version: input.version,
    commitSha,
    releaseId: input.releaseId,
    assetIdentity: JSON.stringify(identity),
  }
}

export function releaseJobRequestHash(request: ReleaseJobRequest): string {
  return createHash('sha256').update(JSON.stringify(normalizeReleaseJobRequest(request))).digest('hex')
}

function releasesRoot(options: ReleaseJobControllerOptions): string {
  return resolve(options.releasesDir ?? process.env.POLO_RELEASES_DIR ?? '/data/releases')
}

function jobRoot(options: ReleaseJobControllerOptions): string {
  return join(releasesRoot(options), 'electron', '.jobs')
}

function jobDirectory(version: string, options: ReleaseJobControllerOptions): string {
  if (parseStrictSemverTag(`v${version}`) !== version) throw new Error('Release job version is invalid')
  return join(jobRoot(options), version)
}

async function readState(version: string, options: ReleaseJobControllerOptions): Promise<ReleaseJobState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(jobDirectory(version, options), 'state.json'), 'utf8')) as Partial<ReleaseJobState>
    if (
      !parsed || !['running', 'success', 'failed', 'cancelled'].includes(parsed.status ?? '')
      || typeof parsed.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.requestHash)
      || typeof parsed.attemptId !== 'string' || !/^[a-f0-9-]{36}$/.test(parsed.attemptId)
      || !Number.isSafeInteger(parsed.pid) || parsed.pid! <= 0
      || typeof parsed.updatedAt !== 'string'
    ) {
      throw new Error(`Release job state is invalid for ${version}`)
    }
    return parsed as ReleaseJobState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writeState(version: string, state: ReleaseJobState, options: ReleaseJobControllerOptions): Promise<void> {
  const directory = jobDirectory(version, options)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.state-${process.pid}-${Date.now()}`)
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(temporary, join(directory, 'state.json'))
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function terminateProcess(pid: number): Promise<void> {
  if (!processAlive(pid)) return
  process.kill(pid, 'SIGTERM')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processAlive(pid)) return
    await delay(100)
  }
  process.kill(pid, 'SIGKILL')
}

async function cleanupIncoming(version: string, options: ReleaseJobControllerOptions): Promise<void> {
  const incomingRoot = join(releasesRoot(options), 'electron', '.incoming')
  const entries = await readdir(incomingRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (entry.name === version || entry.name.startsWith(`.${version}.download-`)) {
      await rm(join(incomingRoot, entry.name), { recursive: true, force: true })
    }
  }
}

async function isVersionLatest(version: string, options: ReleaseJobControllerOptions): Promise<boolean> {
  try {
    return await readlink(join(releasesRoot(options), 'electron', 'latest')) === `releases/${version}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function requestArguments(request: ReleaseJobRequest): string[] {
  return [
    '--repo', request.repository,
    '--tag', request.tag,
    '--version', request.version,
    '--commit', request.commitSha,
    '--release-id', String(request.releaseId),
    '--asset-identity', request.assetIdentity,
  ]
}

function defaultSpawnWorker(args: string[], logPath: string, workerReleasesDir: string): number {
  const log = openSync(logPath, 'a', 0o600)
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker', ...args], {
      detached: true,
      env: { ...process.env, POLO_RELEASES_DIR: workerReleasesDir },
      stdio: ['ignore', log, log],
    })
    if (!child.pid) throw new Error('Release job worker did not receive a PID')
    child.unref()
    return child.pid
  } finally {
    closeSync(log)
  }
}

export async function startReleaseJob(
  input: ReleaseJobRequest,
  options: ReleaseJobControllerOptions = {},
): Promise<ReleaseJobStatus> {
  const request = normalizeReleaseJobRequest(input)
  const requestHash = releaseJobRequestHash(request)
  const root = jobRoot(options)
  const directory = jobDirectory(request.version, options)
  const lock = join(root, `.${request.version}.start-lock`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Release job start lock is already held for ${request.version}`)
    }
    throw error
  }
  try {
    const current = await readState(request.version, options)
    if (current && current.requestHash !== requestHash) {
      throw new Error(`Release job ${request.version} is bound to a different approved Draft`)
    }
    const alive = options.processAlive ?? processAlive
    if (current?.status === 'running' && alive(current.pid)) return 'running'
    if (current?.status === 'success' && await isVersionLatest(request.version, options)) return 'success'

    await cleanupIncoming(request.version, options)
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const spawnWorker = options.spawnWorker
      ?? ((args, logPath) => defaultSpawnWorker(args, logPath, releasesRoot(options)))
    const attemptId = randomUUID()
    const workerArgs = ['--request-hash', requestHash, '--attempt-id', attemptId, ...requestArguments(request)]
    const pid = spawnWorker(workerArgs, join(directory, 'worker.log'))
    await writeState(request.version, {
      status: 'running',
      requestHash,
      attemptId,
      pid,
      updatedAt: new Date().toISOString(),
    }, options)
    return 'running'
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

export async function getReleaseJobStatus(
  version: string,
  options: ReleaseJobControllerOptions = {},
): Promise<ReleaseJobStatus | 'missing'> {
  const current = await readState(version, options)
  if (!current) return 'missing'
  if (current.status !== 'running') return current.status
  const alive = options.processAlive ?? processAlive
  if (alive(current.pid)) return 'running'
  await writeState(version, { ...current, status: 'failed', updatedAt: new Date().toISOString() }, options)
  return 'failed'
}

export async function cancelReleaseJob(
  version: string,
  options: ReleaseJobControllerOptions = {},
): Promise<ReleaseJobStatus | 'missing'> {
  const current = await readState(version, options)
  if (!current) {
    await cleanupIncoming(version, options)
    return 'missing'
  }
  const alive = options.processAlive ?? processAlive
  if (current.status === 'running' && alive(current.pid)) {
    await (options.terminateProcess ?? terminateProcess)(current.pid)
  }
  await cleanupIncoming(version, options)
  if (current.status === 'success') return 'success'
  await writeState(version, { ...current, status: 'cancelled', updatedAt: new Date().toISOString() }, options)
  return 'cancelled'
}

export async function runReleaseJobWorker(
  input: ReleaseJobRequest,
  expectedHash: string,
  expectedAttemptId: string,
  options: ReleaseJobControllerOptions = {},
): Promise<void> {
  const request = normalizeReleaseJobRequest(input)
  const requestHash = releaseJobRequestHash(request)
  if (requestHash !== expectedHash) throw new Error('Release job worker request hash is invalid')
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await readState(request.version, options)
    if (
      current?.status === 'running'
      && current.requestHash === requestHash
      && current.attemptId === expectedAttemptId
    ) {
      ready = true
      break
    }
    await delay(10)
  }
  if (!ready) throw new Error('Release job worker state was not initialized')
  try {
    await (options.pull ?? pullRelease)({
      repository: request.repository,
      tag: request.tag,
      version: request.version,
      commitSha: request.commitSha,
      releaseId: request.releaseId,
      assetIdentity: request.assetIdentity,
    })
    await writeState(request.version, {
      status: 'success', requestHash, attemptId: expectedAttemptId, pid: process.pid, updatedAt: new Date().toISOString(),
    }, options)
  } catch (error) {
    await writeState(request.version, {
      status: 'failed', requestHash, attemptId: expectedAttemptId, pid: process.pid, updatedAt: new Date().toISOString(),
    }, options)
    throw error
  }
}

function requestFromValues(values: Record<string, string | undefined>): ReleaseJobRequest {
  return normalizeReleaseJobRequest({
    repository: required(values, 'repo'),
    tag: required(values, 'tag'),
    version: required(values, 'version'),
    commitSha: required(values, 'commit'),
    releaseId: Number(required(values, 'release-id')),
    assetIdentity: required(values, 'asset-identity'),
  })
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      tag: { type: 'string' },
      version: { type: 'string' },
      commit: { type: 'string' },
      'release-id': { type: 'string' },
      'asset-identity': { type: 'string' },
      'request-hash': { type: 'string' },
      'attempt-id': { type: 'string' },
    },
    strict: true,
  })
  if (command === 'start') {
    console.log(`${JOB_STATUS_PREFIX}${await startReleaseJob(requestFromValues(values))}`)
    return
  }
  if (command === 'status') {
    console.log(`${JOB_STATUS_PREFIX}${await getReleaseJobStatus(required(values, 'version'))}`)
    return
  }
  if (command === 'cancel') {
    console.log(`${JOB_STATUS_PREFIX}${await cancelReleaseJob(required(values, 'version'))}`)
    return
  }
  if (command === 'worker') {
    await runReleaseJobWorker(
      requestFromValues(values),
      required(values, 'request-hash'),
      required(values, 'attempt-id'),
    )
    return
  }
  throw new Error('Usage: polo-release-job <start|status|cancel> [options]')
}

if (import.meta.main) await main()
