import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMcpServers } from '../src/mcp-servers.mjs'

function homeWith(files) {
  const home = mkdtempSync(join(tmpdir(), 'mcp-servers-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(home, rel, '..'), { recursive: true })
    writeFileSync(join(home, rel), JSON.stringify(content))
  }
  return home
}

test('Gemini\'s own MCP file is read: the panel lists its servers beside the other agents', () => {
  const home = homeWith({
    '.claude.json': { mcpServers: { collab: { command: '/opt/homebrew/bin/node', args: ['x'] } } },
    '.gemini/config/mcp_config.json': {
      mcpServers: {
        collab: { command: '/opt/homebrew/bin/node', args: ['server.mjs'], env: { COLLAB_AGENT_ID: 'gemini' }, disabled: false },
        docs: { serverUrl: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer secret-token' } }
      }
    }
  })
  try {
    const servers = readMcpServers(home)
    const collab = servers.find((s) => s.name === 'collab')
    assert.deepEqual(collab.agents.sort(), ['claude', 'gemini'], 'collab is shown for Gemini too')
    const docs = servers.find((s) => s.name === 'docs')
    assert.deepEqual(docs.agents, ['gemini'])
    assert.equal(docs.transport, 'http')
    assert.equal(docs.target, 'https://mcp.example.com/mcp')
    assert.ok(!JSON.stringify(servers).includes('secret-token'), 'headers and env never reach the panel: they are where tokens live')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a machine without Gemini\'s file lists nothing for it and does not fail', () => {
  const home = homeWith({ '.claude.json': { mcpServers: { collab: { command: 'node' } } } })
  try {
    const collab = readMcpServers(home).find((s) => s.name === 'collab')
    assert.deepEqual(collab.agents, ['claude'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
