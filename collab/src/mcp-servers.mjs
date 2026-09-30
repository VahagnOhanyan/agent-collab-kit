// Machine-wide MCP servers: the ones an agent has in its OWN user-level config,
// not the ones a project declares (a project's .mcp.json is deliberately not
// read — a server that only exists for one project is not part of the kit).
//
// Only name, transport and a short target come out. env, args and headers are
// never read into the result: they are where tokens live.

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

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
      found.push({ name, agent: 'claude', transport: remote ? 'http' : 'stdio', target: remote ? safeUrl(spec.url) : basename(String(spec?.command || '')) })
    }
  }
  return found
}

function codexServers(home) {
  let text
  try {
    text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
  } catch {
    return []
  }
  const found = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    const header = /^\[([^\]]+)\]$/.exec(trimmed)
    if (header) {
      const table = /^mcp_servers\.("[^"]+"|[^.]+)$/.exec(header[1])
      current = table ? { name: table[1].replace(/^"|"$/g, ''), agent: 'codex', transport: 'stdio', target: '' } : null
      if (current) found.push(current)
      continue
    }
    if (!current) continue
    const url = /^url\s*=\s*"([^"]*)"/.exec(trimmed)
    const command = /^command\s*=\s*"([^"]*)"/.exec(trimmed)
    if (url) {
      current.transport = 'http'
      current.target = safeUrl(url[1])
    } else if (command) {
      current.target = basename(command[1])
    }
  }
  return found
}

export function readMcpServers(home) {
  const byName = new Map()
  for (const s of [...claudeServers(home), ...codexServers(home)]) {
    const row = byName.get(s.name) || { name: s.name, transport: s.transport, target: s.target, agents: [] }
    if (!row.agents.includes(s.agent)) row.agents.push(s.agent)
    if (!row.target) row.target = s.target
    byName.set(s.name, row)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
