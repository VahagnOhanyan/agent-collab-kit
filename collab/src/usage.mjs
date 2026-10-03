// What a task cost: tokens, and for Codex the share of the weekly limit — read from the agents' own session logs, on
// demand, never written to the journal.
//
// ⛔ THIS IS A READING, NOT A LEDGER. The numbers come from files the layer does not own and cannot check, and a
// session often does more than one task, so every figure is bounded by the window the task was held and is marked
// approximate when the window is shared. Nothing here gates anything.
//
// Where the facts come from (probed 03.10.2026):
//  · Claude — `projects/*/<session>.jsonl` under a Claude config dir, plus `<session>/subagents/agent-*.jsonl`. The MCP
//    process knows its session (CLAUDE_CODE_SESSION_ID), so a claim records it. A message is logged up to six times,
//    once per content block, with the same id: summed by id (the fullest copy), never by line.
//  · Codex — `sessions/YYYY/MM/DD/rollout-*.jsonl`. The MCP process is not told its session, but the log records every
//    `McpToolCall collab claim_task` with the task id, so the thread is found from the task, not from the process.
//    `token_count` carries a running total and `rate_limits.primary.used_percent`: a WEEKLY share, whole numbers, for
//    the whole account — it includes everything else Codex did in the window.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE_MAX = 48
const cache = new Map()

// A session file is parsed once per (path, mtime, size): a log of tens of megabytes is not re-read for every page view.
function cached(file, parse) {
  const st = statSync(file)
  const key = `${file}|${st.mtimeMs}|${st.size}`
  if (cache.has(key)) return cache.get(key)
  const value = parse(readFileSync(file, 'utf8'))
  cache.set(key, value)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return value
}

const ZERO = () => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0 })
const add = (to, from) => {
  for (const key of Object.keys(ZERO())) to[key] += from[key] || 0
  return to
}

export function defaultRoots(home = homedir()) {
  let claudeConfigDirs = []
  try {
    claudeConfigDirs = readdirSync(home)
      .filter((name) => name === '.claude' || name.startsWith('.claude-'))
      .map((name) => join(home, name))
      .filter((dir) => existsSync(join(dir, 'projects')))
  } catch {
    claudeConfigDirs = []
  }
  return { claudeConfigDirs, codexDir: join(home, '.codex', 'sessions') }
}

// ── Claude ──────────────────────────────────────────────────────────────────

function parseClaude(text) {
  const byId = new Map()
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const usage = entry.message?.usage
    if (entry.type !== 'assistant' || !usage) continue
    const model = entry.message.model
    if (!model || model.startsWith('<')) continue
    const ts = Date.parse(entry.timestamp)
    if (!Number.isFinite(ts)) continue
    const row = {
      ts,
      model,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cache_creation: usage.cache_creation_input_tokens || 0,
      cache_read: usage.cache_read_input_tokens || 0
    }
    const id = entry.message.id || entry.requestId || entry.uuid
    const prev = byId.get(id)
    // The same message again: the fullest copy (the output count grows as it streams), at its first moment.
    if (!prev) byId.set(id, row)
    else if (row.output >= prev.output) byId.set(id, { ...row, ts: Math.min(prev.ts, ts) })
  }
  return [...byId.values()]
}

function claudeFiles(configDirs, sessionId) {
  const main = []
  const subagents = []
  for (const dir of configDirs) {
    const projects = join(dir, 'projects')
    let names = []
    try {
      names = readdirSync(projects)
    } catch {
      continue
    }
    for (const name of names) {
      const file = join(projects, name, `${sessionId}.jsonl`)
      if (existsSync(file)) main.push(file)
      const subDir = join(projects, name, sessionId, 'subagents')
      if (existsSync(subDir)) {
        for (const sub of readdirSync(subDir)) if (sub.endsWith('.jsonl')) subagents.push(join(subDir, sub))
      }
    }
  }
  return { main, subagents }
}

// Null when the session's log is not on this machine: "no data", which is not the same as zero.
export function claudeUsage({ configDirs, sessionId, from, to }) {
  if (!sessionId) return null
  const { main, subagents } = claudeFiles(configDirs, sessionId)
  if (!main.length) return null
  const byModel = {}
  let messages = 0
  for (const file of [...main, ...subagents]) {
    for (const row of cached(file, parseClaude)) {
      if (row.ts < from || row.ts > to) continue
      messages += 1
      add((byModel[row.model] ||= { ...ZERO(), messages: 0 }), row)
      byModel[row.model].messages += 1
    }
  }
  return { agent: 'claude', session_id: sessionId, from, to, by_model: byModel, messages, subagent_logs: subagents.length }
}

// ── Codex ───────────────────────────────────────────────────────────────────

function parseCodex(text) {
  const claims = []
  const counts = []
  const models = []
  for (const line of text.split('\n')) {
    const isCount = line.includes('"token_count"')
    const isClaim = !isCount && line.includes('"claim_task"') && line.includes('McpToolCall')
    const isTurn = !isCount && !isClaim && line.includes('"turn_context"')
    if (!isCount && !isClaim && !isTurn) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const ts = Date.parse(entry.timestamp)
    if (!Number.isFinite(ts)) continue
    const p = entry.payload || {}
    if (isCount && p.type === 'token_count' && p.info?.total_token_usage) {
      const t = p.info.total_token_usage
      const limit = p.rate_limits?.primary
      counts.push({
        ts,
        input: (t.input_tokens || 0) - (t.cached_input_tokens || 0),
        cache_read: t.cached_input_tokens || 0,
        output: t.output_tokens || 0,
        pct: typeof limit?.used_percent === 'number' ? limit.used_percent : null,
        resets: limit?.resets_at ?? null
      })
    } else if (isClaim && p.item?.type === 'McpToolCall' && p.item.server === 'collab' && p.item.tool === 'claim_task') {
      claims.push({ ts, task_id: p.item.arguments?.task_id || null, thread: p.thread_id || null })
    } else if (isTurn && p.model) {
      models.push({ ts, model: p.model })
    }
  }
  return { claims, counts, models }
}

function rolloutFiles(codexDir, sinceMs) {
  const out = []
  const walk = (dir, depth) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      if (depth < 3) walk(path, depth + 1)
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        try {
          if (statSync(path).mtimeMs >= sinceMs) out.push(path)
        } catch {
          // a file that vanished between the listing and the stat is not a log
        }
      }
    }
  }
  walk(codexDir, 0)
  return out
}

const lastAtOrBefore = (rows, ts) => {
  let found = null
  for (const row of rows) {
    if (row.ts > ts) break
    found = row
  }
  return found
}

// One part per Codex thread that claimed the task. `since` bounds which logs are even opened (a log last written
// before the task existed cannot hold its claim).
export function codexUsage({ codexDir, taskId, since, to }) {
  const parts = []
  for (const file of rolloutFiles(codexDir, since)) {
    const log = cached(file, parseCodex)
    const claim = log.claims.find((c) => c.task_id === taskId)
    if (!claim) continue
    const end = lastAtOrBefore(log.counts, to)
    if (!end || end.ts < claim.ts) continue
    const base = lastAtOrBefore(log.counts, claim.ts)
    const used = ZERO()
    for (const key of ['input', 'cache_read', 'output']) used[key] = end[key] - (base ? base[key] : 0)
    const sameWindow = base && base.resets !== null && base.resets === end.resets && base.pct !== null && end.pct !== null
    parts.push({
      agent: 'codex',
      thread: claim.thread,
      from: claim.ts,
      to: Math.min(to, end.ts),
      by_model: { [lastAtOrBefore(log.models, end.ts)?.model || 'unknown']: { ...used, messages: null } },
      // Whole weekly percent for the whole account: what moved while the task was held, not what the task cost.
      limit_percent: sameWindow ? Math.max(0, end.pct - base.pct) : null
    })
  }
  return parts
}

// ── a task ──────────────────────────────────────────────────────────────────

export function sumUsage(parts) {
  const total = ZERO()
  for (const part of parts) for (const row of Object.values(part.by_model || {})) add(total, row)
  return total
}

// A task's cost: the Claude sessions it was claimed from and the Codex threads that claimed it, each within the time
// the task was held. `allTasks` is read only to see whether a Claude session was shared with another task in the same
// window — then the figure is a ceiling for this task, not its own, and says so.
export function usageOfTask({ task, allTasks = [], now, terminal, roots = defaultRoots() }) {
  const sessions = task.sessions || []
  const end = terminal && task.updated_at ? Date.parse(task.updated_at) : now
  const parts = []
  let approximate = false
  sessions.forEach((entry, index) => {
    if (!entry.session_id) return
    const from = Date.parse(entry.from)
    const to = sessions[index + 1] ? Date.parse(sessions[index + 1].from) : end
    const part = claudeUsage({ configDirs: roots.claudeConfigDirs, sessionId: entry.session_id, from, to })
    if (!part) return
    parts.push(part)
    const shared = allTasks.some((other) => {
      if (other.id === task.id) return false
      const otherEnd = other.status === 'completed' || other.status === 'cancelled' ? Date.parse(other.updated_at) || now : now
      return (other.sessions || []).some((s) => s.session_id === entry.session_id && Date.parse(s.from) < to && otherEnd > from)
    })
    if (shared) approximate = true
  })
  const codexInvolved = task.owner === 'codex' || sessions.some((s) => s.agent === 'codex') || (task.contributors || []).includes('codex')
  if (codexInvolved) {
    const since = Date.parse(task.created_at) || 0
    parts.push(...codexUsage({ codexDir: roots.codexDir, taskId: task.id, since, to: end }))
  }
  return { parts, total: sumUsage(parts), approximate, none: parts.length === 0 }
}
