#!/usr/bin/env node
// Register the collaboration MCP server with the Codex CLI.
//
// ~/.codex/config.toml is the user's own file and holds unrelated settings, so
// this rewrites exactly one block and nothing else: it finds an existing
// [mcp_servers.collab] section and replaces it, or appends one. A timestamped
// backup is written first, and --check prints what would happen without
// touching anything.
//
// Deliberately not a TOML parser: parsing and re-emitting the whole file would
// reformat sections this script has no business touching, and losing a comment
// in someone's config is a bad trade for tidiness.
//
// Usage:
//   node collab/codex/install.mjs           install or update the block
//   node collab/codex/install.mjs --check   say what it would do

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// collab/codex -> collab/src/mcp/server.mjs, wherever this package is installed
const SERVER = resolve(HERE, '..', 'src', 'mcp', 'server.mjs')
const CONFIG = process.env.CODEX_CONFIG || join(homedir(), '.codex', 'config.toml')
const CHECK = process.argv.includes('--check')

const BLOCK = [
  '[mcp_servers.collab]',
  '# collab — shared tasks, messages, reviews, decisions and approvals for',
  '# every project on this machine. Managed by collab/codex/install.mjs (agent-kit).',
  'command = "node"',
  `args = ["${SERVER}"]`,
  'env = { COLLAB_AGENT_ID = "codex" }',
  'startup_timeout_sec = 20'
].join('\n')

// A section runs until the next top-level [table] header or end of file.
function replaceSection(text, header, replacement) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === header)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i
      break
    }
  }
  return [...lines.slice(0, start), ...replacement.split('\n'), '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
}

if (!existsSync(SERVER)) {
  console.error(`the collab server is not where this script expects it: ${SERVER}`)
  process.exit(1)
}

const exists = existsSync(CONFIG)
const current = exists ? readFileSync(CONFIG, 'utf8') : ''
const already = current.includes('[mcp_servers.collab]')
const next = already ? replaceSection(current, '[mcp_servers.collab]', BLOCK) : `${current.trimEnd()}\n\n${BLOCK}\n`

if (next === current) {
  console.log(`already registered and unchanged: ${CONFIG}`)
  process.exit(0)
}

if (CHECK) {
  console.log(
    exists
      ? `${already ? 'would REPLACE' : 'would APPEND'} [mcp_servers.collab] in ${CONFIG}`
      : `${CONFIG} does not exist — would create it with the block below`
  )
  console.log(`\n${BLOCK}\n`)
  process.exit(0)
}

if (exists) {
  const backup = `${CONFIG}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(CONFIG, backup)
  console.log(`backed up  ${backup}`)
} else {
  mkdirSync(dirname(CONFIG), { recursive: true })
}

writeFileSync(CONFIG, next, 'utf8')
console.log(`${already ? 'updated' : 'added'}    [mcp_servers.collab] in ${CONFIG}`)
console.log('\nCodex picks this up on its next start. Verify from a Codex session with the collab tool `whoami`.')
