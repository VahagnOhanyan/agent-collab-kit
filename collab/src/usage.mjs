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

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
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
  // Codex moves a finished session out of `sessions/` into `archived_sessions/`: a cost that was readable while the
  // thread ran must stay readable after it is archived, so both are read.
  return { claudeConfigDirs, codexDir: join(home, '.codex', 'sessions'), codexArchiveDir: join(home, '.codex', 'archived_sessions') }
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
      id: entry.message.id || entry.requestId || entry.uuid,
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

// A session id is a file name here, so it is only ever a plain token: whatever a process wrote into the journal as its
// session is not allowed to walk out of the projects directory.
export const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/

function claudeFiles(configDirs, sessionId) {
  const main = []
  const subagents = []
  if (!SESSION_ID.test(String(sessionId))) return { main, subagents }
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
  // One message is one message however many files hold it: the same file reached through two config dirs (a symlink),
  // or an id repeated between the main log and a subagent's. Deduplicated across all of them, fullest copy kept.
  const byId = new Map()
  for (const file of new Set([...main, ...subagents].map((f) => realpathSync(f)))) {
    for (const row of cached(file, parseClaude)) {
      const prev = byId.get(row.id)
      if (!prev || row.output >= prev.output) byId.set(row.id, row)
    }
  }
  const byModel = {}
  let messages = 0
  for (const row of byId.values()) {
    if (row.ts < from || row.ts > to) continue
    messages += 1
    add((byModel[row.model] ||= { ...ZERO(), messages: 0 }), row)
    byModel[row.model].messages += 1
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

// Which tasks a rollout claimed, kept for EVERY log: a few numbers per file, so the question "which logs belong to this
// task" is answered from memory after the first pass. The full parse (every token_count) is only paid for the logs
// that answer yes. Without it each task re-read the whole directory — 610 logs, 2.3 GB on the owner's machine —
// because the full-parse cache holds 48 files and a pass over more than that evicts itself.
const claimIndex = new Map()
const CLAIM_INDEX_MAX = 4000
function claimsOf(file) {
  const st = statSync(file)
  const key = `${file}|${st.mtimeMs}|${st.size}`
  if (claimIndex.has(key)) return claimIndex.get(key)
  const claims = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"claim_task"') || !line.includes('McpToolCall')) continue
    try {
      const entry = JSON.parse(line)
      const item = entry.payload?.item
      if (item?.type === 'McpToolCall' && item.server === 'collab' && item.tool === 'claim_task') {
        claims.push({ ts: Date.parse(entry.timestamp), task_id: item.arguments?.task_id || null, thread: entry.payload.thread_id || null })
      }
    } catch {
      // a half-written last line of a live log is not a claim
    }
  }
  claimIndex.set(key, claims)
  while (claimIndex.size > CLAIM_INDEX_MAX) claimIndex.delete(claimIndex.keys().next().value)
  return claims
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
      // `sessions/` keeps logs in YYYY/MM/DD, `archived_sessions/` flat: a log is recognised by its name wherever it sits.
      if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        try {
          if (statSync(path).mtimeMs >= sinceMs) out.push(path)
        } catch {
          // a file that vanished between the listing and the stat is not a log
        }
      } else if (depth < 3) walk(path, depth + 1)
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

// How far a claim in a log may sit from the moment the journal recorded the same claim: two clocks, one call.
const CLAIM_SLACK_MS = 60_000

// One part per (Codex thread, stretch of work). `spans` are the stretches the journal knows — [{from, to}] — and each
// is matched to the claim in the log that opened it, so a thread's work between a release and the next claim is not
// counted. A task with no recorded stretch (taken before they were kept) is read as one, from its first claim to `to`.
// `since` bounds which logs are even opened (a log last written before the task existed cannot hold its claim).
export function codexUsage({ codexDir, archiveDir = null, taskId, since, to, spans = null }) {
  const parts = []
  const stretches = spans?.length ? spans : [{ from: null, to }]
  const files = [...rolloutFiles(codexDir, since), ...(archiveDir ? rolloutFiles(archiveDir, since) : [])]
  for (const file of new Set(files)) {
    const claims = claimsOf(file).filter((c) => c.task_id === taskId)
    if (!claims.length) continue
    const log = cached(file, parseCodex)
    for (const span of stretches) {
      const claim = span.from === null ? claims[0] : claims.find((c) => c.ts >= span.from - CLAIM_SLACK_MS && c.ts <= span.to)
      if (!claim) continue
      const end = lastAtOrBefore(log.counts, span.to)
      if (!end || end.ts < claim.ts) continue
      const base = lastAtOrBefore(log.counts, claim.ts)
      const used = ZERO()
      for (const key of ['input', 'cache_read', 'output']) used[key] = end[key] - (base ? base[key] : 0)
      const sameWindow = base && base.resets !== null && base.resets === end.resets && base.pct !== null && end.pct !== null
      parts.push({
        agent: 'codex',
        thread: claim.thread,
        from: claim.ts,
        to: Math.min(span.to, end.ts),
        by_model: { [lastAtOrBefore(log.models, end.ts)?.model || 'unknown']: { ...used, messages: null } },
        // Whole weekly percent for the whole account: what moved while the task was held, not what the task cost.
        limit_percent: sameWindow ? Math.max(0, end.pct - base.pct) : null,
        // Another task claimed in the same thread inside the stretch: the tokens are the thread's, not this task's alone.
        shared: log.claims.some((c) => c.task_id && c.task_id !== taskId && c.ts >= claim.ts && c.ts <= span.to)
      })
    }
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
// The stretches of a task as [from, to] in milliseconds. A stretch ends where the journal says it did (`to`, written when
// the task lost its owner); one without — written before that was kept — runs up to the next stretch, or to the end.
function stretchesOf(task, end) {
  const sessions = task.sessions || []
  return sessions.map((entry, index) => ({
    entry,
    from: Date.parse(entry.from),
    to: entry.to ? Date.parse(entry.to) : sessions[index + 1] ? Date.parse(sessions[index + 1].from) : end
  }))
}

export function usageOfTask({ task, allTasks = [], now, terminal, roots = defaultRoots() }) {
  const sessions = task.sessions || []
  const end = terminal && task.updated_at ? Date.parse(task.updated_at) : now
  const parts = []
  let approximate = false
  const mine = stretchesOf(task, end)
  for (const { entry, from, to } of mine) {
    if (!entry.session_id) continue
    const part = claudeUsage({ configDirs: roots.claudeConfigDirs, sessionId: entry.session_id, from, to })
    if (!part) continue
    parts.push(part)
    const shared = allTasks.some((other) => {
      if (other.id === task.id) return false
      const otherEnd = other.status === 'completed' || other.status === 'cancelled' ? Date.parse(other.updated_at) || now : now
      return stretchesOf(other, otherEnd).some((s) => s.entry.session_id === entry.session_id && s.from < to && s.to > from)
    })
    if (shared) approximate = true
  }
  const codexInvolved = task.owner === 'codex' || sessions.some((s) => s.agent === 'codex') || (task.contributors || []).includes('codex')
  if (codexInvolved) {
    const since = Date.parse(task.created_at) || 0
    const spans = mine.filter(({ entry }) => entry.agent === 'codex').map(({ from, to }) => ({ from, to }))
    const codexParts = codexUsage({ codexDir: roots.codexDir, archiveDir: roots.codexArchiveDir, taskId: task.id, since, to: end, spans })
    if (codexParts.some((part) => part.shared)) approximate = true
    parts.push(...codexParts)
  }
  return { parts, total: sumUsage(parts), approximate, none: parts.length === 0 }
}
