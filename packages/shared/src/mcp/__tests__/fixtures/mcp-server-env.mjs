#!/usr/bin/env node
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

rl.on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-server-env', version: '1.0.0' },
      },
    })
    return
  }
  if (request.method === 'notifications/initialized') return
  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{
          name: 'environment_snapshot',
          description: 'Return selected environment variables',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    })
    return
  }
  if (request.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify(process.env),
        }],
      },
    })
    return
  }
  if (typeof request.id !== 'undefined') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: 'Method not found' },
    })
  }
})
