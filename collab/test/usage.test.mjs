// What a task cost, read from the agents' own session logs (usage.mjs). The logs are fixtures written here in the
// shapes the real ones have (probed 03.10.2026): a Claude message logged more than once under one id, and a Codex
// rollout with a claim_task call, token_count running totals and the weekly percent.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { fixedClock } from '../src/ids.mjs'
import { claudeUsage, codexUsage, sumUsage, usageOfTask } from '../src/usage.mjs'
import { sandbox } from './helpers.mjs'

const T = (minute) => `2026-10-03T10:${String(minute).padStart(2, '0')}:00.000Z`
const ms = (minute) => Date.parse(T(minute))

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const assistant = (id, minute, output, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: T(minute),
    message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }, ...extra }
  })

function claudeWorld(sessionId, lines, subagentLines = null) {
  const s = scratch()
  const config = join(s.dir, '.claude-x')
  const project = join(config, 'projects', '-proj')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  if (subagentLines) {
    mkdirSync(join(project, sessionId, 'subagents'), { recursive: true })
    writeFileSync(join(project, sessionId, 'subagents', 'agent-a1.jsonl'), subagentLines.join('\n') + '\n')
  }
  return { ...s, configDirs: [config] }
}

test('a Claude message logged several times counts once, as its fullest copy', () => {
  const w = claudeWorld('sess-1', [assistant('m1', 1, 5), assistant('m1', 1, 40), assistant('m1', 1, 40), assistant('m2', 2, 7)])
  try {
    const u = claudeUsage({ configDirs: w.configDirs, sessionId: 'sess-1', from: ms(0), to: ms(10) })
    const row = u.by_model['claude-sonnet-5-5']
    assert.equal(row.output, 47, 'm1 counts its fullest copy (40) once, plus m2 (7) — not 5+40+40+7')
    assert.equal(row.input, 20)
    assert.equal(row.cache_read, 2000)
    assert.equal(row.messages, 2)
  } finally {
    w.cleanup()
  }
})

test('only what falls inside the window the task was held is counted, and subagents are included', () => {
  const w = claudeWorld('sess-2', [assistant('a', 1, 10), assistant('b', 5, 20), assistant('c', 9, 30)], [assistant('s1', 6, 100)])
  try {
    const u = claudeUsage({ configDirs: w.configDirs, sessionId: 'sess-2', from: ms(4), to: ms(8) })
    assert.equal(u.by_model['claude-sonnet-5-5'].output, 120, 'b (20) and the subagent message (100); a is before, c after')
    assert.equal(u.subagent_logs, 1)
  } finally {
    w.cleanup()
  }
})

test('a session whose log is not on this machine is "no data", not zero', () => {
  const w = claudeWorld('sess-3', [assistant('a', 1, 1)])
  try {
    assert.equal(claudeUsage({ configDirs: w.configDirs, sessionId: 'sess-missing', from: 0, to: Date.now() }), null)
    assert.equal(claudeUsage({ configDirs: w.configDirs, sessionId: null, from: 0, to: Date.now() }), null)
  } finally {
    w.cleanup()
  }
})

const codexCount = (minute, input, cached, output, pct, resets = 5000) =>
  JSON.stringify({
    timestamp: T(minute),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
      rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: resets } }
    }
  })
const codexClaim = (minute, taskId) =>
  JSON.stringify({ timestamp: T(minute), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thr-1', item: { type: 'McpToolCall', server: 'collab', tool: 'claim_task', arguments: { task_id: taskId } } } })
const codexTurn = (minute, model) => JSON.stringify({ timestamp: T(minute), type: 'turn_context', payload: { model } })

function codexWorld(files) {
  const s = scratch()
  const day = join(s.dir, '2026', '10', '03')
  mkdirSync(day, { recursive: true })
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(day, `rollout-${name}.jsonl`), lines.join('\n') + '\n')
  return { ...s, codexDir: s.dir }
}

test('Codex: the thread is found from the claim, and tokens and percent are what moved since it', () => {
  const w = codexWorld({
    a: [codexTurn(0, 'gpt-5.6-terra'), codexCount(1, 1000, 400, 100, 10), codexClaim(2, 'tsk_x'), codexCount(3, 1600, 700, 160, 11), codexCount(8, 5000, 2000, 500, 14)],
    b: [codexClaim(2, 'tsk_other'), codexCount(9, 99999, 0, 99999, 50)]
  })
  try {
    const [part, ...rest] = codexUsage({ codexDir: w.codexDir, taskId: 'tsk_x', since: 0, to: ms(20) })
    assert.equal(rest.length, 0, 'the other thread claimed another task')
    const row = part.by_model['gpt-5.6-terra']
    assert.equal(row.output, 400, '500 - 100 at the claim')
    assert.equal(row.cache_read, 1600, '2000 - 400')
    assert.equal(row.input, 2400, 'fresh input: (5000-2000) - (1000-400)')
    assert.equal(part.limit_percent, 4, '14 - 10')
  } finally {
    w.cleanup()
  }
})

test('Codex: the window ends where the task did, and a reset weekly window gives no percent rather than a wrong one', () => {
  const w = codexWorld({
    a: [codexClaim(1, 'tsk_y'), codexCount(2, 100, 0, 10, 20, 5000), codexCount(6, 900, 0, 90, 3, 9999)]
  })
  try {
    const [part] = codexUsage({ codexDir: w.codexDir, taskId: 'tsk_y', since: 0, to: ms(4) })
    assert.equal(part.by_model.unknown.output, 10, 'the 06 reading is after the task ended')
    const [late] = codexUsage({ codexDir: w.codexDir, taskId: 'tsk_y', since: 0, to: ms(9) })
    assert.equal(late.limit_percent, null, 'the percent counter restarted: the difference would be meaningless')
  } finally {
    w.cleanup()
  }
})

test('a Claude session shared with another task in the same window makes the figure approximate', () => {
  const w = claudeWorld('sess-9', [assistant('a', 2, 10), assistant('b', 6, 20)])
  try {
    const roots = { claudeConfigDirs: w.configDirs, codexDir: join(w.dir, 'none') }
    const mine = { id: 'tsk_mine', status: 'in_progress', sessions: [{ agent: 'claude', session_id: 'sess-9', from: T(1) }] }
    const alone = usageOfTask({ task: mine, allTasks: [mine], now: ms(30), terminal: false, roots })
    assert.equal(alone.approximate, false)
    assert.equal(alone.total.output, 30)
    const other = { id: 'tsk_other', status: 'in_progress', sessions: [{ agent: 'claude', session_id: 'sess-9', from: T(3) }] }
    const shared = usageOfTask({ task: mine, allTasks: [mine, other], now: ms(30), terminal: false, roots })
    assert.equal(shared.approximate, true)
    assert.equal(sumUsage(shared.parts).output, 30)
    const nothing = usageOfTask({ task: { id: 'tsk_none', status: 'created' }, allTasks: [], now: ms(30), terminal: false, roots })
    assert.equal(nothing.none, true)
  } finally {
    w.cleanup()
  }
})

test('a claim records the session the claiming agent names — and never one inherited from another agent', async () => {
  const sbx = sandbox()
  const clock = fixedClock()
  const claudeApi = createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir, clock, sessionId: 'sess-claude' })
  const codexApi = createApi({ agentId: 'codex', roots: sbx.roots, configDir: sbx.configDir, clock })
  const saved = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'inherited-from-a-claude-parent'
  try {
    const a = await claudeApi.createTask({ title: 'Claude takes this one', action: 'edit a file' })
    const first = await claudeApi.claimTask({ task_id: a.id })
    assert.deepEqual(first.task.sessions.map((s) => [s.agent, s.session_id]), [['claude', 'sess-claude']])
    const again = await claudeApi.claimTask({ task_id: a.id })
    assert.equal(again.task.sessions.length, 1, 'taking it again from the same session is not a new stretch of work')

    const b = await codexApi.createTask({ title: 'Codex takes this one', action: 'edit a file' })
    const claimed = await codexApi.claimTask({ task_id: b.id })
    assert.equal(claimed.task.sessions[0].session_id, null, 'codex was not given a session, and must not borrow the one its parent process has')
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = saved
    sbx.cleanup()
  }
})
