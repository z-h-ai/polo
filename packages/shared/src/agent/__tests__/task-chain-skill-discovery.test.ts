import { expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestAgent, createMockBackendConfig, createMockWorkspace } from './test-utils.ts'
import { clearBundledAssetsRoot, getBundledAssetsRoot, setBundledAssetsRoot } from '../../utils/paths.ts'

class Consumer extends TestAgent {
  check(tool: string, input: Record<string, unknown>) { return this.checkCanonicalSkillUse(tool, input) }
}

it('discovers the shipped task-chain Skill from natural language without injecting its instructions into every turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-task-chain-discovery-'))
  const saved = getBundledAssetsRoot()
  const assets = fileURLToPath(new URL('../../../../../apps/electron', import.meta.url))
  const skillFile = join(assets, 'resources/builtin-skills/task-chain-pubsub/SKILL.md')
  const body = await readFile(skillFile, 'utf-8')
  try {
    setBundledAssetsRoot(assets)
    // Bundled guidance remains available even when enterprise policy disables local Skills.
    const agent = new Consumer(createMockBackendConfig({
      workspace: createMockWorkspace({ rootPath: root }),
      canonicalSkills: { allowLocalSkills: async () => false, load: async () => [], authorize: async () => {}, finish: async () => {} },
    }))
    const turn = agent.chat('等实现登录这个会话完成后，自动继续审查')
    try {
      await turn.next()
      const injected = agent.chatCalls[0]!.message
      expect(injected).toContain('task-chain-pubsub')
      expect(injected).toContain(skillFile)
      expect(injected).not.toContain(body)
      expect(injected).not.toContain('## 注册后结束 turn')
      expect(await agent.check('Read', { file_path: skillFile })).toBeNull()
    } finally {
      await turn.return(undefined as never)
    }
  } finally {
    if (saved === undefined) clearBundledAssetsRoot()
    else setBundledAssetsRoot(saved)
    await rm(root, { recursive: true, force: true })
  }
})
