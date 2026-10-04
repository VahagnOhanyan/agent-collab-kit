import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PLACEHOLDER, cleanArgs, mcpAddCommands, sharedSpec, sharedSpecFromToml } from '../src/mcp-share.mjs'
import { readMcpServers } from '../src/mcp-servers.mjs'
import { mcpRows } from '../../ui/kit-files.mjs'

const SECRETS = ['secret-env-value', 'secret-header-value', 'secret-flag-value', 'secret-eq-value', 'k3yInTheQuery', 'AbCdEf0123456789GhIjKl9876', 'leak-header-123', 'leak-json-456', 'real-secret']
const skipWindows = process.platform === 'win32'

// Runs a copied command the way a person would paste it, in a throwaway HOME.
function pasteInShell(command) {
  const home = mkdtempSync(join(tmpdir(), 'mcp-paste-'))
  execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  return home
}

test('an http server with a key header: each vendor gets a terminal command, the whole header value is ВАШ_КЛЮЧ', { skip: skipWindows }, () => {
  const share = sharedSpec('context7', { type: 'http', url: 'https://user:pw@mcp.context7.com/mcp?api_key=k3yInTheQuery#x', headers: { CONTEXT7_API_KEY: 'secret-header-value' } })
  assert.deepEqual(share, { name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp', headers: ['CONTEXT7_API_KEY'] })
  const c = mcpAddCommands(share)
  assert.equal(c.claude, `claude mcp add --scope user --transport http context7 https://mcp.context7.com/mcp --header 'CONTEXT7_API_KEY: ${PLACEHOLDER}'`)
  assert.equal(c.gemini, `agy mcp add --header 'CONTEXT7_API_KEY: ${PLACEHOLDER}' context7 https://mcp.context7.com/mcp`, 'agy: flags before the name')
  // Codex CLI sets no headers: its command appends a real TOML table, which is checked by pasting it.
  const codexHome = pasteInShell(c.codex)
  try {
    const toml = readFileSync(join(codexHome, '.codex', 'config.toml'), 'utf8')
    assert.match(toml, /^\[mcp_servers\.context7\]\nurl = "https:\/\/mcp\.context7\.com\/mcp"\nhttp_headers = \{ "CONTEXT7_API_KEY" = "ВАШ_КЛЮЧ" \}$/m)
  } finally {
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('Authorization is a placeholder as a whole: no scheme is made up (Basic stays possible)', () => {
  const c = mcpAddCommands(sharedSpec('remote', { url: 'https://example.test/mcp', headers: { Authorization: 'Basic real-secret' } }))
  assert.ok(!/Bearer|Basic/.test(JSON.stringify(c)), 'no scheme in any command')
  assert.match(c.claude, /--header 'Authorization: ВАШ_КЛЮЧ'$/)
})

test('a stdio server with env and arguments: env names only, -- before the program, quoting where needed', () => {
  const share = sharedSpec('chrome', { command: 'npx', args: ['chrome-devtools-mcp@latest', '--isolated', 'a b'], env: { DEBUG_TOKEN: 'secret-env-value' } })
  const c = mcpAddCommands(share)
  assert.equal(c.claude, `claude mcp add --scope user chrome -e 'DEBUG_TOKEN=${PLACEHOLDER}' -- npx chrome-devtools-mcp@latest --isolated 'a b'`)
  assert.equal(c.codex, `codex mcp add chrome --env 'DEBUG_TOKEN=${PLACEHOLDER}' -- npx chrome-devtools-mcp@latest --isolated 'a b'`)
  assert.equal(c.gemini, `agy mcp add --env 'DEBUG_TOKEN=${PLACEHOLDER}' chrome -- npx chrome-devtools-mcp@latest --isolated 'a b'`)
})

test('Cursor gets a terminal command too: pasted, it adds the entry to ~/.cursor/mcp.json and keeps the rest; a second paste refuses', { skip: skipWindows }, () => {
  const c = mcpAddCommands(sharedSpec('chrome', { command: 'npx', args: ['chrome-devtools-mcp@latest'], env: { DEBUG_TOKEN: 'x' } }))
  assert.match(c.cursor, /^node -e '/)
  const home = mkdtempSync(join(tmpdir(), 'mcp-cursor-'))
  try {
    mkdirSync(join(home, '.cursor'))
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } }, other: 1 }))
    execFileSync('/bin/sh', ['-c', c.cursor], { env: { ...process.env, HOME: home }, stdio: 'pipe' })
    const data = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
    assert.deepEqual(data.mcpServers.chrome, { command: 'npx', args: ['chrome-devtools-mcp@latest'], env: { DEBUG_TOKEN: PLACEHOLDER } })
    assert.deepEqual(data.mcpServers.mine, { command: 'x' })
    assert.equal(data.other, 1)
    assert.throws(() => execFileSync('/bin/sh', ['-c', c.cursor], { env: { ...process.env, HOME: home }, stdio: 'pipe' }), 'a server of that name is not overwritten')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an argument that may hold a secret is replaced: header values, JWT, JSON, prefixes, random strings, secret words', () => {
  assert.deepEqual(
    cleanArgs(['--header', 'Authorization: Bearer leak-header-123', '-H', 'X: y', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', '{"token":"leak-json-456"}', '{"x":"leak-json-789"}',
      '--token', 'secret-flag-value', '--api-key=secret-eq-value', 'API_KEY=secret-eq-value', 'ghp_abc', 'AbCdEf0123456789GhIjKl9876',
      'https://x.example/mcp?key=k3yInTheQuery', 'mysecretvalue', '--port', '8080', 'pkg@latest']),
    ['--header', PLACEHOLDER, '-H', PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER,
      '--token', PLACEHOLDER, `--api-key=${PLACEHOLDER}`, `API_KEY=${PLACEHOLDER}`, PLACEHOLDER, PLACEHOLDER,
      'https://x.example/mcp', PLACEHOLDER, '--port', '8080', 'pkg@latest'])
})

test('the program is shown as it is, a name that would be an option is refused, control characters give no command', () => {
  assert.equal(sharedSpec('srv', { command: 'sk-tool', args: [] }).command, 'sk-tool')
  for (const name of ['--help', '-e', '']) assert.equal(sharedSpec(name, { command: 'node' }), null, JSON.stringify(name))
  assert.equal(sharedSpec('srv', { command: 'node', args: ['\u001b[2Jhidden'] }), null)
  assert.equal(sharedSpec('srv', { command: 'no\u0007de' }), null)
})

test('collab is never offered: the installer registers it with a different id for every vendor', () => {
  assert.equal(sharedSpec('collab', { command: '/opt/homebrew/bin/node', args: ['server.mjs'] }), null)
})

test('Codex TOML: inline and nested env/headers, single-quoted strings; a form that is not read gives no command rather than a wrong one', () => {
  assert.deepEqual(sharedSpecFromToml('chrome', ['command = "npx"', 'args = ["pkg", "--token", "secret-flag-value"]', 'env = { DEBUG_TOKEN = "secret-env-value" }']),
    { name: 'chrome', transport: 'stdio', command: 'npx', args: ['pkg', '--token', PLACEHOLDER], env: ['DEBUG_TOKEN'] })
  assert.deepEqual(sharedSpecFromToml('nested', ['command = \'npx\'', 'args = [\'pkg\']', 'env.API_KEY = "real-secret"']).env, ['API_KEY'])
  assert.deepEqual(sharedSpecFromToml('docs', ['url = "https://docs.example/mcp"', 'http_headers.X-Key = "real-secret"', 'bearer_token_env_var = "DOCS_TOKEN"']).headers, ['X-Key', 'Authorization'])
  assert.equal(sharedSpecFromToml('odd', ['command = "npx"', 'args = [']), null)
})

test('the panel answer: commands only for vendors that lack the server, nested TOML keys kept by name, and no secret anywhere', () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-share-'))
  const write = (rel, data) => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), typeof data === 'string' ? data : JSON.stringify(data)) }
  write('.claude.json', { mcpServers: {
    context7: { type: 'http', url: 'https://mcp.context7.com/mcp?api_key=k3yInTheQuery', headers: { CONTEXT7_API_KEY: 'secret-header-value' } },
    chrome: { command: 'npx', args: ['chrome-devtools-mcp@latest', '--header', 'Authorization: Bearer leak-header-123', '{"token":"leak-json-456"}'], env: { DEBUG_TOKEN: 'secret-env-value' } },
    collab: { command: 'node', args: ['server.mjs'], env: { COLLAB_AGENT_ID: 'claude' } }
  } })
  write('.gemini/config/mcp_config.json', { mcpServers: { context7: { serverUrl: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'secret-header-value' } } } })
  write('.codex/config.toml', '[mcp_servers.nested]\ncommand = "npx"\nargs = ["pkg"]\n\n[mcp_servers.nested.env]\nAPI_KEY = "real-secret"\n')
  try {
    const rows = mcpRows(readMcpServers(home, { catalogAgents: [], machineAdapters: [] }))
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    assert.deepEqual(Object.keys(byName.context7.commands).sort(), ['codex', 'cursor'], 'Claude and Gemini already have context7')
    assert.deepEqual(Object.keys(byName.chrome.commands).sort(), ['codex', 'cursor', 'gemini'])
    assert.deepEqual(byName.collab.commands, {})
    assert.match(byName.nested.commands.claude, /-e 'API_KEY=ВАШ_КЛЮЧ'/, 'the key of a nested [..env] table is not lost')
    assert.equal(byName.chrome.share, undefined, 'the description itself stays out of the answer')
    const text = JSON.stringify(rows)
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} never reaches the panel`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
