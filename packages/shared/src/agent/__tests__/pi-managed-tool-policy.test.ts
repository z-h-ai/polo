import { expect, test } from 'bun:test'
import { PiAgent } from '../pi-agent'

function agent(managed = true) {
  let executions = 0
  const value = new PiAgent({ provider: 'pi', workspace: { id: 'policy', name: 'Policy', rootPath: '/tmp/policy' }, isHeadless: true, ...(managed ? { toolExecutionPolicy: 'managed-file-only' } : {}), mcpPool: { getProxyToolDefs() { executions++; return [{ name: 'mcp__probe__run' }] }, isProxyTool() { executions++; return true }, async callTool() { executions++; return { content: 'BAD', isError: false } } } } as any) as any
  value.executeSessionTool = async () => { executions++; return { content: 'BAD', isError: false } }
  const sent: any[] = []; value.send = (message: any) => sent.push(message)
  return { value, sent, executions: () => executions }
}

test('managed host rejects forged proxy/pre-tool calls before any session, source, permission or Skill dispatch', async () => {
  const { value, sent, executions } = agent()
  for (const toolName of ['mcp__session__script_sandbox', 'mcp__session__transform_data', 'mcp__session__call_llm', 'mcp__probe__run']) {
    await value.handleToolExecuteRequest({ requestId: toolName, toolName, args: {} })
    expect(sent.at(-1).result.isError).toBe(true)
    expect(sent.at(-1).result.content).toContain('POLO_MANAGED_TOOL_UNSUPPORTED')
    expect((await value.routeToolCall(toolName, {})).isError).toBe(true)
  }
  await value.handlePreToolUseRequest({ requestId: 'shell', toolName: 'Bash', input: { command: 'echo BAD' } })
  expect(sent.at(-1).action).toBe('block')
  expect(executions()).toBe(0)
  expect(value.buildSessionToolDefs()).toEqual([])
  value.registerPoolToolsWithSubprocess()
  expect(executions()).toBe(0)
})

test('owned host retains original proxy execution', async () => {
  const { value, executions } = agent(false)
  expect((await value.routeToolCall('mcp__session__script_sandbox', {})).isError).toBe(false)
  expect(executions()).toBe(1)
})
