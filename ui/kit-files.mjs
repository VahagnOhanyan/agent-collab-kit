import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'

import { readMcpServers } from '../collab/src/mcp-servers.mjs'
import { mcpAddCommands } from '../collab/src/mcp-share.mjs'

function scalar(value) {
  const clean = value.trim()
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) return clean.slice(1, -1)
  if (clean.startsWith('[') && clean.endsWith(']')) return clean.slice(1, -1).split(',').map((item) => scalar(item)).filter(Boolean)
  return clean
}

function frontmatter(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') throw new Error('missing opening frontmatter delimiter')
  const end = lines.indexOf('---', 1)
  if (end === -1) throw new Error('missing closing frontmatter delimiter')
  const fields = {}
  for (const line of lines.slice(1, end)) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line)
    if (match) fields[match[1]] = scalar(match[2])
  }
  return fields
}

function filesAt(dir, select) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(select).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function record(file, kitRoot, fields) {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file')
    return { ...fields(frontmatter(file)), path: relative(kitRoot, file) }
  } catch (error) {
    return { ...fields({}), path: relative(kitRoot, file), problem: error.message }
  }
}

export function readKitFiles(kitRoot, { home = homedir() } = {}) {
  const skills = filesAt(join(kitRoot, 'skills'), (entry) => entry.isDirectory()).map((entry) => {
    const file = join(kitRoot, 'skills', entry.name, 'SKILL.md')
    return record(file, kitRoot, (meta) => ({ name: meta.name || entry.name, description: meta.description || '' }))
  })
  const agents = filesAt(join(kitRoot, 'agents'), (entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => {
    const file = join(kitRoot, 'agents', entry.name)
    return record(file, kitRoot, (meta) => ({
      name: meta.name || basename(entry.name, '.md'),
      description: meta.description || '',
      model: meta.model || null,
      tools: Array.isArray(meta.tools) ? meta.tools : typeof meta.tools === 'string' ? meta.tools.split(',').map((tool) => tool.trim()).filter(Boolean) : []
    }))
  })
  const rules = filesAt(join(kitRoot, 'rules'), (entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => ({
    name: basename(entry.name, '.md'),
    path: relative(kitRoot, join(kitRoot, 'rules', entry.name))
  }))
  return { skills, agents, rules, mcp: [...mcpRows(readMcpServers(home)), ...projectMcpRows(home)] }
}

// Servers the kit registered for ONE project (`state/project-mcp.json`, written by the installer). They are not in any
// user-level config, so readMcpServers never sees them; the record is the only place they are listed. Shown with the
// project's name and no add-commands: such a server is deliberately not offered to other agents or projects.
function projectMcpRows(home) {
  let registrations = []
  try {
    const parsed = JSON.parse(readFileSync(join(home, '.agent-collab-kit', 'state', 'project-mcp.json'), 'utf8'))
    if (Array.isArray(parsed?.registrations)) registrations = parsed.registrations
  } catch {
    return []
  }
  const rows = new Map()
  for (const entry of registrations) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.project !== 'string') continue
    let target = ''
    try {
      const url = new URL(entry.url)
      target = `${url.origin}${url.pathname === '/' ? '' : url.pathname}`
    } catch {
      // A record without a readable URL is listed by name only.
    }
    // One server registered in several Claude accounts is still one row.
    const key = `${entry.project}\n${entry.name}`
    if (!rows.has(key)) rows.set(key, { name: entry.name, transport: target ? 'http' : '', target, agents: ['claude'], commands: {}, project: entry.project })
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// The vendors a copied command is written for: the clients whose MCP settings the kit knows how to read.
const COMMAND_VENDORS = ['claude', 'codex', 'gemini', 'cursor']

// Each server with the commands that add it to the vendors that do not have it yet. The description itself (`share`)
// stays out of the answer: the commands are all the page needs.
export function mcpRows(servers) {
  return servers.map(({ share, ...row }) => {
    const all = mcpAddCommands(share)
    const commands = all ? Object.fromEntries(COMMAND_VENDORS.filter((vendor) => !row.agents.includes(vendor) && all[vendor]).map((vendor) => [vendor, all[vendor]])) : {}
    return { ...row, commands }
  })
}
