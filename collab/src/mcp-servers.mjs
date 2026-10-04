// Machine-wide MCP servers: the ones an agent has in its OWN user-level config,
// not the ones a project declares (a project's .mcp.json is deliberately not
// read — a server that only exists for one project is not part of the kit).
//
// Only name, transport and a short target come out, plus `share` — what it takes to add the same server to another
// vendor (sharedSpec): values of env and headers are never read into the result, only their NAMES, and an argument
// that looks like a secret is replaced. They are where tokens live.

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { loadBuiltinAgents } from './registry.mjs'
import { sharedSpec, sharedSpecFromToml } from './mcp-share.mjs'

// The program name only. A command written as an array (`["node", "--token", "…"]`) or anything but a string carries
// arguments, and arguments are where tokens live: it gives no name at all.
function commandName(spec) {
  return typeof spec?.command === 'string' ? basename(spec.command) : ''
}

function safeUrl(value) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return ''
  }
}

function claudeServers(home) {
  let names = []
  try {
    names = readdirSync(home)
  } catch {
    return []
  }
  const files = ['.claude.json', ...names.filter((n) => /^\.claude[-\w]*$/.test(n)).map((n) => join(n, '.claude.json'))]
  const found = []
  for (const rel of files) {
    let config
    try {
      config = JSON.parse(readFileSync(join(home, rel), 'utf8'))
    } catch {
      continue
    }
    for (const [name, spec] of Object.entries(config?.mcpServers || {})) {
      const remote = typeof spec?.url === 'string'
      found.push({ name, agent: 'claude', transport: remote ? 'http' : 'stdio', target: remote ? safeUrl(spec.url) : commandName(spec), share: sharedSpec(name, spec) })
    }
  }
  return found
}

function codexServers(home) {
  return tomlServers(join(home, '.codex', 'config.toml'), 'mcp_servers', 'codex')
}

// One TOML settings file whose servers are tables named `<tableKey>.<server>`.
function tomlServers(file, tableKey, agent) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const key = tableKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tableHeader = new RegExp(`^${key}\\.("[^"]+"|[^.]+)$`)
  // A server's nested tables (`[mcp_servers.x.env]`): their keys belong to that server, prefixed with the section.
  const nestedHeader = new RegExp(`^${key}\\.("[^"]+"|[^.]+)\\.(env|http_headers|env_http_headers)$`)
  const found = []
  let current = null
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    const header = /^\[([^\]]+)\]$/.exec(trimmed)
    if (header) {
      const table = tableHeader.exec(header[1])
      const nested = nestedHeader.exec(header[1])
      section = ''
      if (table) {
        current = { name: table[1].replace(/^"|"$/g, ''), agent, transport: 'stdio', target: '', lines: [] }
        found.push(current)
      } else if (nested) {
        current = found.find((server) => server.name === nested[1].replace(/^"|"$/g, '')) || null
        section = nested[2]
      } else current = null
      continue
    }
    if (!current) continue
    if (section) {
      if (trimmed && !trimmed.startsWith('#')) current.lines.push(`${section}.${trimmed}`)
      continue
    }
    current.lines.push(trimmed)
    const url = /^url\s*=\s*"([^"]*)"/.exec(trimmed)
    const command = /^command\s*=\s*"([^"]*)"/.exec(trimmed)
    if (url) {
      current.transport = 'http'
      current.target = safeUrl(url[1])
    } else if (command) {
      current.target = basename(command[1])
    }
  }
  return found.map(({ lines, ...server }) => ({ ...server, share: sharedSpecFromToml(server.name, lines) }))
}

// Cursor's user-level MCP settings: ~/.cursor/mcp.json, `mcpServers` keyed by name (the editor and its CLI share it).
function cursorServers(home) {
  let data
  try {
    data = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
  } catch {
    return []
  }
  const servers = data && typeof data.mcpServers === 'object' && data.mcpServers ? data.mcpServers : {}
  return Object.entries(servers).map(([name, spec]) => {
    const remote = typeof spec?.url === 'string'
    return { name, agent: 'cursor', transport: remote ? 'http' : 'stdio', target: remote ? safeUrl(spec.url) : commandName(spec), share: sharedSpec(name, spec) }
  })
}

// Gemini (Antigravity CLI, `agy`): ~/.gemini/config/mcp_config.json, `mcpServers` keyed by name. A remote server is
// written with `url` or `serverUrl`; a disabled one (`disabled: true`) is still configured, so it is listed.
function geminiServers(home) {
  let data
  try {
    data = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'))
  } catch {
    return []
  }
  const servers = data && typeof data.mcpServers === 'object' && data.mcpServers ? data.mcpServers : {}
  return Object.entries(servers).map(([name, spec]) => {
    const address = typeof spec?.url === 'string' ? spec.url : typeof spec?.serverUrl === 'string' ? spec.serverUrl : null
    return { name, agent: 'gemini', transport: address ? 'http' : 'stdio', target: address ? safeUrl(address) : commandName(spec), share: sharedSpec(name, spec) }
  })
}

// A JSON settings file whose servers sit under `serversKey` (dotted for a nested one).
function jsonServers(file, serversKey, agent) {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  let servers = data
  for (const key of serversKey.split('.')) servers = servers && typeof servers === 'object' ? servers[key] : undefined
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
  return Object.entries(servers).map(([name, spec]) => {
    const address = typeof spec?.url === 'string' ? spec.url : typeof spec?.serverUrl === 'string' ? spec.serverUrl : null
    return { name, agent, transport: address ? 'http' : 'stdio', target: address ? safeUrl(address) : commandName(spec), share: sharedSpec(name, spec) }
  })
}

// Vendors that describe their own MCP settings file: the kit's catalog (`adapter.mcp_registration`) and the machine
// adapters adopted on this machine. The same description the installer writes collab by, so a vendor added by data is
// listed here without code of its own. Display only: nothing here is run, and the path stays inside the home.
function describedServers(home, { catalogAgents, machineAdapters }) {
  const sources = []
  for (const agent of catalogAgents ?? defaultCatalogAgents()) {
    if (agent?.adapter?.mcp_registration) sources.push({ id: agent.id, registration: agent.adapter.mcp_registration })
  }
  for (const adapter of machineAdapters ?? defaultMachineAdapters(home)) {
    if (adapter?.registration) sources.push({ id: adapter.id, registration: adapter.registration })
  }
  const found = []
  for (const { id, registration } of sources) {
    const { kind, config_path: configPath, servers_key: serversKey } = registration
    if (typeof configPath !== 'string' || !configPath.startsWith('~/') || configPath.split('/').includes('..') || typeof serversKey !== 'string') continue
    const file = join(home, configPath.slice(2))
    // Through links too: a settings file that is a link out of the home is not read.
    if (!insideHome(home, file)) continue
    if (kind === 'json-file') found.push(...jsonServers(file, serversKey, id))
    else if (kind === 'toml-file') found.push(...tomlServers(file, serversKey, id))
  }
  return found
}

function insideHome(home, file) {
  try {
    const root = realpathSync(home)
    const real = realpathSync(file)
    return real === root || real.startsWith(root + sep)
  } catch {
    return false
  }
}

function defaultCatalogAgents() {
  try {
    return loadBuiltinAgents().agents || []
  } catch {
    return []
  }
}

function defaultMachineAdapters(home) {
  const dir = join(home, '.agent-collab-kit', 'collab', 'adapters')
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
  const adapters = []
  for (const name of names) {
    // Only an adapter the owner approved, the way the installer reads it: a plain file whose bytes are the ones the
    // `.approved` mark beside it names, and whose file name is its id. Anything else is not listed.
    try {
      const file = join(dir, name)
      if (!lstatSync(file).isFile()) continue
      const bytes = readFileSync(file)
      const mark = `${file}.approved`
      if (!lstatSync(mark).isFile() || readFileSync(mark, 'utf8').trim() !== createHash('sha256').update(bytes).digest('hex')) continue
      const adapter = JSON.parse(bytes.toString('utf8'))
      if (name !== `${adapter?.id}.json`) continue
      adapters.push(adapter)
    } catch {
      // A broken adapter file is the installer's to report; the list just leaves it out.
    }
  }
  return adapters
}

export function readMcpServers(home, options = {}) {
  const byName = new Map()
  for (const s of [...claudeServers(home), ...codexServers(home), ...cursorServers(home), ...geminiServers(home), ...describedServers(home, options)]) {
    const row = byName.get(s.name) || { name: s.name, transport: s.transport, target: s.target, agents: [], share: null }
    if (!row.agents.includes(s.agent)) row.agents.push(s.agent)
    if (!row.target) row.target = s.target
    // The first readable description wins (Claude's is read first): one server, one way to add it elsewhere.
    if (!row.share && s.share) row.share = s.share
    byName.set(s.name, row)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
