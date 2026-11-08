import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * POO-196 R3 P12-5 outside-in acceptance — the project's title (+ optional
 * introduction) reaches the REAL model request context.
 *
 * Chain under test: SessionManager.createSession (projectContext persisted
 * under the trusted space binding) → production factory → REAL PiAgent →
 * REAL pi-agent-server subprocess → pi-coding-agent SDK (appendSystemPrompt)
 * → captured OpenAI-compatible model request. Only the LLM is a local fake;
 * the request body it captures IS the artifact of record for 验收要点 7.
 *
 * Assertions mirror consensus P12-5 / D12 scenarioR3ProjectModelContext:
 * 1. a unique-name project's first turn carries the name in the system
 *    context (verbatim, via the <project_context> block);
 * 2. an EMPTY purpose emits no introduction line (no placeholder invention);
 * 3. project B's requests never carry project A's name (isolation);
 * 4. no fabricated user message — the only user turn is what was actually
 *    sent (the metadata rides the system side, never a chat message).
 */

// The pi bundle staging reuses the PRODUCTION build invocation via the
// scripts/ tree (outside this package's tsconfig graph), exactly like the
// request-user-input acceptance.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const configRoot = mkdtempSync(join(tmpdir(), 'p125-acceptance-config-'))
// SessionManager.createSession reads config defaults (rate limits etc.) —
// seed a minimal defaults file the way the app's ensureConfigDir() would.
copyFileSync(join(REPO_ROOT, 'apps', 'electron', 'resources', 'config-defaults.json'), join(configRoot, 'config-defaults.json'))
const configRootSeen: string[] = []
process.env.POLO_AI_CONFIG_DIR = configRoot

const { SessionManager, setSessionPlatform } = await import('./SessionManager.ts')
const { setInvocationLlmConnections } = await import('@polo-ai/shared/config')
const { setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount } = await import('../runtime/product-space-executions')
const { setSyncTrustedProductSpaceAccountId, setTrustedProductSpaceAccountProvider } = await import('../handlers/rpc/trusted-product-space-account')
const { piAgentServerBuildArgs } = await import('../../../../scripts/build/pi-build-args.ts') as {
  piAgentServerBuildArgs: (src: string, outdir: string) => string[]
}

const TEST_ACCOUNT_ID = 'account-a'
const TEST_SPACE_ID = 'space-personal'

describe('P12-5 project context reaches the real model request (production Pi chain)', () => {
  let tmpRoot: string
  let piStagingLayout: string | null = null
  let sm: InstanceType<typeof import('./SessionManager').SessionManager>
  const seededSessionIds = new Set<string>()

  function ensurePiServerStaging(): string {
    if (piStagingLayout) return piStagingLayout
    const layout = mkdtempSync(join(REPO_ROOT, 'node_modules', 'acceptance-pi-runtime-'))
    const outdir = join(layout, 'packages', 'pi-agent-server', 'dist')
    rmSync(outdir, { force: true })
    const src = join(REPO_ROOT, 'packages', 'pi-agent-server', 'src', 'index.ts')
    const build = Bun.spawnSync({
      cmd: [process.execPath, ...piAgentServerBuildArgs(src, outdir)],
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const staged = join(outdir, 'index.js')
    if (build.exitCode !== 0 || !existsSync(staged)) {
      throw new Error(`acceptance setup: building pi-agent-server failed (exit ${build.exitCode})\n${build.stderr?.toString() ?? ''}`)
    }
    piStagingLayout = layout
    return layout
  }

  function usePiHostRuntime(): void {
    setSessionPlatform({
      appRootPath: ensurePiServerStaging(),
      resourcesPath: ensurePiServerStaging(),
      isPackaged: false,
      appVersion: 'test',
      logger: {
        info: (...args: unknown[]) => console.log('[p125]', ...args),
        warn: (...args: unknown[]) => console.warn('[p125]', ...args),
        error: (...args: unknown[]) => console.error('[p125]', ...args),
        debug: (...args: unknown[]) => console.debug('[p125:debug]', ...args),
      },
      isDebugMode: false,
    } as never)
  }

  interface CapturedModelRequest {
    model?: string
    rawBody: string
    userTexts: string[]
    systemText: string
  }

  /** OpenAI-compatible capture endpoint: records the FULL request body (the
   *  artifact of record) and always answers a plain text completion. */
  function startFakeModelServer() {
    const captured: CapturedModelRequest[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (!url.pathname.endsWith('/chat/completions')) {
          return new Response('not found', { status: 404 })
        }
        const raw = await request.text()
        const body = JSON.parse(raw) as Record<string, unknown>
        const messages = (body.messages as Array<{ role?: string; content?: unknown }> | undefined) ?? []
        captured.push({
          model: body.model as string | undefined,
          rawBody: raw,
          userTexts: messages
            .filter(m => m.role === 'user')
            .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
          systemText: messages
            .filter(m => m.role === 'system')
            .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
            .join('\n'),
        })
        const chunks: string[] = []
        chunks.push(`data: ${JSON.stringify({
          id: 'chatcmpl-p125',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }],
        })}\n\n`)
        chunks.push(`data: ${JSON.stringify({
          id: 'chatcmpl-p125',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`)
        chunks.push(`data: ${JSON.stringify({
          id: 'chatcmpl-p125',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`)
        chunks.push('data: [DONE]\n\n')
        return new Response(chunks.join(''), {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' },
        })
      },
    })
    return { captured, url: `http://127.0.0.1:${server.port}` }
  }

  function usePiConnection(slug: string, baseUrl: string): void {
    setInvocationLlmConnections([{
      slug,
      name: slug,
      providerType: 'pi_compat',
      authType: 'api_key',
      baseUrl,
      customEndpoint: { api: 'openai-completions' },
      models: ['test-model'],
      defaultModel: 'test-model',
      createdAt: Date.now(),
    }], slug)
  }

  async function waitForCondition(check: () => boolean, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('waitForCondition timed out')
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'p125-acceptance-runtime-'))
    sm = new SessionManager({ workspace: { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() } as never })
    setSyncTrustedProductSpaceAccountId(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpaceAccount(TEST_ACCOUNT_ID)
    // POO-205 v2: project context rides ENTERPRISE sessions bound to a
    // project — the runtime fence must commit the space as enterprise and
    // every project-bound session must carry its projectId.
    setRuntimeActiveProductSpace(TEST_SPACE_ID, 'enterprise')
    setTrustedProductSpaceAccountProvider(async () => TEST_ACCOUNT_ID)
    sm.setEventSink((() => {}) as never)
  })

  afterEach(async () => {
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    const queue = (sm as unknown as { sessionStorage: { persistenceQueue: { cancel: (id: string) => void } } }).sessionStorage.persistenceQueue
    for (const id of seededSessionIds) {
      try { queue.cancel(id) } catch { /* ignore */ }
    }
    seededSessionIds.clear()
    await new Promise(r => setTimeout(r, 650))
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    setSyncTrustedProductSpaceAccountId(null)
    if (piStagingLayout) {
      rmSync(piStagingLayout, { recursive: true, force: true })
    }
    try { rmSync(configRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('unique-name project + empty purpose: the FIRST real model request carries the name in the system context, with no fabricated user message', async () => {
    usePiHostRuntime()
    const fake = startFakeModelServer()
    usePiConnection('p125-fake', fake.url)

    const uniqueName = `P12-5上下文验证-甲-${Math.random().toString(36).slice(2, 8)}`
    const created = await sm.createSession('ws_test', {
      name: 'p125-a',
      llmConnection: 'p125-fake',
      // POO-205 v2: an enterprise session MUST carry its project binding;
      // the context below is the projection of THAT project.
      projectId: 'project-alpha',
      // EMPTY purpose — the acceptance-critical shape (验收要点 7).
      projectContext: { name: uniqueName, purpose: '' },
    })
    const sessionId = (created as { id: string }).id
    seededSessionIds.add(sessionId)

    const sentText = '请只回复 done'
    await sm.sendMessage(sessionId, sentText, [], [], { invocationSource: 'desktop' })
    await waitForCondition(() => fake.captured.length >= 1)
    await waitForCondition(() => {
      const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId) as { isProcessing?: boolean } | undefined
      return !managed?.isProcessing
    })

    expect(fake.captured.length).toBeGreaterThanOrEqual(1)
    const first = fake.captured[0]!
    // 验收要点 7: the project NAME is in the real request context (system side,
    // via the <project_context> append) — verbatim, not paraphrased.
    expect(first.rawBody).toContain(uniqueName)
    expect(first.rawBody).toContain('<project_context>')
    expect(first.rawBody).toContain(`Project name: ${uniqueName}`)
    // Empty purpose emits NO introduction line (nothing is invented).
    expect(first.rawBody).not.toContain('Project introduction:')

    // P12-5 discipline: the metadata rides the SYSTEM context — the only user
    // message is what the user actually sent (no fabricated project chat).
    const userJoined = first.userTexts.join('\n')
    expect(userJoined).toContain(sentText)
    expect(userJoined).not.toContain(uniqueName)
  })

  it("isolation: a second project's requests carry ONLY their own project's name", async () => {
    usePiHostRuntime()
    const fake = startFakeModelServer()
    usePiConnection('p125-fake-b', fake.url)

    const nameA = `P12-5上下文-甲-${Math.random().toString(36).slice(2, 8)}`
    const nameB = `P12-5上下文-乙-${Math.random().toString(36).slice(2, 8)}`

    const a = await sm.createSession('ws_test', {
      name: 'p125-iso-a',
      llmConnection: 'p125-fake-b',
      projectId: 'project-iso-a',
      projectContext: { name: nameA, purpose: '' },
    })
    const idA = (a as { id: string }).id
    seededSessionIds.add(idA)
    await sm.sendMessage(idA, '项目甲的第一条', [], [], { invocationSource: 'desktop' })
    await waitForCondition(() => fake.captured.length >= 1)

    const b = await sm.createSession('ws_test', {
      name: 'p125-iso-b',
      llmConnection: 'p125-fake-b',
      projectId: 'project-iso-b',
      projectContext: { name: nameB, purpose: '乙项目介绍' },
    })
    const idB = (b as { id: string }).id
    seededSessionIds.add(idB)
    await sm.sendMessage(idB, '项目乙的第一条', [], [], { invocationSource: 'desktop' })
    await waitForCondition(() => fake.captured.length >= 2)

    const first = fake.captured[0]!
    const second = fake.captured[1]!
    // A carries A, never B.
    expect(first.rawBody).toContain(nameA)
    expect(first.rawBody).not.toContain(nameB)
    // B carries B (and its introduction), never A — cross-project isolation.
    expect(second.rawBody).toContain(nameB)
    expect(second.rawBody).toContain('乙项目介绍')
    expect(second.rawBody).not.toContain(nameA)
  })
})
