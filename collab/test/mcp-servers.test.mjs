import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
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

// ── a vendor described by data (adapter.mcp_registration in the catalog, or an adopted machine adapter) ──

test('a catalog vendor that describes its settings file is listed without code of its own: JSON and TOML, no secrets', () => {
  const home = homeWith({ '.vendor-a/mcp.json': { mcp: { servers: { collab: { command: 'node' }, docs: { url: 'https://mcp.example.com/mcp?key=secret-in-url', headers: { Authorization: 'Bearer secret-token' } } } } } })
  mkdirSync(join(home, '.vendor-b'), { recursive: true })
  writeFileSync(join(home, '.vendor-b', 'config.toml'), '[mcp_servers.collab]\ncommand = "/usr/bin/node"\nenv = { TOKEN = "secret-env" }\n\n[mcp_servers.other]\nurl = "https://other.example.com/mcp"\n')
  try {
    const catalogAgents = [
      { id: 'vendor-a', adapter: { mcp_registration: { kind: 'json-file', config_path: '~/.vendor-a/mcp.json', servers_key: 'mcp.servers' } } },
      { id: 'vendor-b', adapter: { mcp_registration: { kind: 'toml-file', config_path: '~/.vendor-b/config.toml', servers_key: 'mcp_servers' } } },
      { id: 'no-description', adapter: {} }
    ]
    const servers = readMcpServers(home, { catalogAgents, machineAdapters: [] })
    assert.deepEqual(servers.find((s) => s.name === 'collab').agents.sort(), ['vendor-a', 'vendor-b'])
    assert.deepEqual(servers.find((s) => s.name === 'docs').agents, ['vendor-a'])
    assert.equal(servers.find((s) => s.name === 'other').transport, 'http')
    const text = JSON.stringify(servers)
    for (const secret of ['secret-token', 'secret-env', 'secret-in-url']) assert.ok(!text.includes(secret), `${secret} never reaches the panel`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an adopted machine adapter is listed too, and a description that points out of the home is ignored', () => {
  const home = homeWith({ '.vendor-c/mcp.json': { mcpServers: { collab: { command: 'node' } } } })
  // A real, readable settings file one level ABOVE the home: only the path rule keeps it out, not a parse failure.
  const outside = join(home, '..', `outside-${process.pid}.json`)
  writeFileSync(outside, JSON.stringify({ mcpServers: { leaked: { command: 'node' } } }))
  try {
    const machineAdapters = [
      { id: 'vendor-c', registration: { kind: 'json-file', config_path: '~/.vendor-c/mcp.json', servers_key: 'mcpServers' } },
      { id: 'evil', registration: { kind: 'json-file', config_path: `~/../outside-${process.pid}.json`, servers_key: 'mcpServers' } }
    ]
    const servers = readMcpServers(home, { catalogAgents: [], machineAdapters })
    assert.deepEqual(servers.find((s) => s.name === 'collab').agents, ['vendor-c'])
    assert.equal(servers.find((s) => s.name === 'leaked'), undefined, 'a file outside the home is never read')
    assert.equal(servers.length, 1)
  } finally {
    rmSync(outside, { force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ── review findings: a command array, an adapter nobody approved, a settings file that is a link out of the home ──

test('a command written as an array gives no name: its arguments are where tokens live', () => {
  const home = homeWith({ '.gemini/config/mcp_config.json': { mcpServers: { docs: { command: ['/usr/bin/node', '--token', 'secret-in-command-array'] } } } })
  try {
    const docs = readMcpServers(home, { catalogAgents: [], machineAdapters: [] }).find((s) => s.name === 'docs')
    assert.equal(docs.target, '')
    assert.ok(!JSON.stringify(docs).includes('secret-in-command-array'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the panel lists only machine adapters the owner approved, and never reads a settings file that is a link out of the home', () => {
  const home = homeWith({
    '.vendor-ok/mcp.json': { mcpServers: { fine: { command: 'node' } } },
    '.agent-collab-kit/collab/adapters/vendor-ok.json': { id: 'vendor-ok', registration: { kind: 'json-file', config_path: '~/.vendor-ok/mcp.json', servers_key: 'mcpServers' } },
    '.agent-collab-kit/collab/adapters/vendor-no.json': { id: 'vendor-no', registration: { kind: 'json-file', config_path: '~/.vendor-no/mcp.json', servers_key: 'mcpServers' } },
    '.vendor-no/mcp.json': { mcpServers: { unapproved: { command: 'node' } } },
    '.agent-collab-kit/collab/adapters/vendor-edited.json': { id: 'vendor-edited', registration: { kind: 'json-file', config_path: '~/.vendor-edited/mcp.json', servers_key: 'mcpServers' } },
    '.vendor-edited/mcp.json': { mcpServers: { 'edited-after-approval': { command: 'node' } } }
  })
  const dir = join(home, '.agent-collab-kit', 'collab', 'adapters')
  // Approved: the mark holds the sha-256 of the file's bytes. vendor-no has no mark at all.
  writeFileSync(join(dir, 'vendor-ok.json.approved'), createHash('sha256').update(readFileSync(join(dir, 'vendor-ok.json'))).digest('hex'))
  // Changed after the owner approved it: the mark names other bytes.
  writeFileSync(join(dir, 'vendor-edited.json.approved'), createHash('sha256').update('what the owner approved').digest('hex'))
  const outside = join(home, '..', `outside-link-${process.pid}.json`)
  writeFileSync(outside, JSON.stringify({ mcpServers: { 'secret-name': { command: 'node' } } }))
  mkdirSync(join(home, '.vendor-link'), { recursive: true })
  symlinkSync(outside, join(home, '.vendor-link', 'mcp.json'))
  try {
    const catalogAgents = [{ id: 'vendor-link', adapter: { mcp_registration: { kind: 'json-file', config_path: '~/.vendor-link/mcp.json', servers_key: 'mcpServers' } } }]
    const names = readMcpServers(home, { catalogAgents }).map((s) => s.name)
    assert.ok(names.includes('fine'), 'the approved adapter is listed')
    assert.ok(!names.includes('unapproved'), 'an adapter without the owner\'s mark is not listed')
    assert.ok(!names.includes('edited-after-approval'), 'an adapter changed after approval is not listed')
    assert.ok(!names.includes('secret-name'), 'a link out of the home is not followed')
  } finally {
    rmSync(outside, { force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
