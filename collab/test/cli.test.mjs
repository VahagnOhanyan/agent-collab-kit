// The CLI, run as a real process.
//
// This file exists because of a bug it would have caught: `inbox` called an
// async facade method without awaiting it, so `list.length` was undefined and
// the command cheerfully printed "nothing addressed to codex" while the message
// sat in the ledger. Every assertion below is about the OUTPUT a human reads,
// because that is the thing that was wrong while every unit test was green.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApi } from '../src/api.mjs'
import { requestApproval } from '../src/domain/approvals.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli.mjs')

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-cli-'))
  return {
    dir,
    claude: createApi({ agentId: 'claude', root: dir }),
    codex: createApi({ agentId: 'codex', root: dir }),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

// env is passed explicitly so a test never inherits the caller's identity.
const run = (dir, args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COLLAB_STATE_DIR: dir, COLLAB_AGENT_ID: '', ...env }
  })

test('inbox prints the message that is actually there', async () => {
  const w = scratch()
  try {
    await w.claude.sendMessage({
      to_agent: 'codex',
      message_type: 'question',
      subject: 'A question for you',
      body: 'Does the registry map every failure path to a tool result?'
    })
    const result = run(w.dir, ['inbox', 'codex'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /claude -> codex/)
    assert.match(result.stdout, /every failure path/)
    assert.doesNotMatch(result.stdout, /nothing addressed/)
  } finally {
    w.cleanup()
  }
})

test('inbox says so honestly when there is nothing', () => {
  const w = scratch()
  try {
    const result = run(w.dir, ['inbox', 'codex'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /nothing addressed to codex/)
  } finally {
    w.cleanup()
  }
})

test('status shows the agents, the tasks and the working tree', async () => {
  const w = scratch()
  try {
    const task = await w.claude.createTask({ title: 'Something to do', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const result = run(w.dir, ['status'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /claude/)
    assert.match(result.stdout, /codex/)
    assert.match(result.stdout, /in_progress\s+1/)
    assert.match(result.stdout, /working tree/)
  } finally {
    w.cleanup()
  }
})

test('task shows the review round and its findings', async () => {
  const w = scratch()
  try {
    const task = await w.claude.createTask({ title: 'Reviewed work', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const review = await w.claude.requestReview({ task_id: task.id })
    await w.codex.submitReview({
      review_id: review.review.id,
      verdict: 'changes_requested',
      summary: 'One path is unhandled.',
      findings: [{ severity: 'major', file: 'a.js', line: 12, note: 'This throw escapes.' }]
    })
    const result = run(w.dir, ['task', task.id])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /changes_requested/)
    assert.match(result.stdout, /\[major\] a\.js:12 This throw escapes\./)
  } finally {
    w.cleanup()
  }
})

test('approvals lists what is waiting on the owner', async () => {
  const w = scratch()
  try {
    await requestApproval(w.codex.ctx, {
      action: 'buy a subscription to the flight data API',
      reason: 'the free tier has no live status',
      cost_estimate: 'about $49/month'
    })
    const result = run(w.dir, ['approvals'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /FINANCIAL/)
    assert.match(result.stdout, /about \$49\/month/)
    assert.match(result.stdout, /requested by codex/)
  } finally {
    w.cleanup()
  }
})

test('approve REFUSES from an agent shell', async () => {
  const w = scratch()
  try {
    const approval = await requestApproval(w.codex.ctx, { action: 'buy a subscription', reason: 'needed' })
    // Every agent's shell carries COLLAB_AGENT_ID. This is the realistic
    // accident the barrier exists for: an agent pattern-matching on a command
    // it saw in the documentation.
    const result = run(w.dir, ['approve', approval.id], { COLLAB_AGENT_ID: 'codex' })
    assert.equal(result.status, 3)
    assert.match(result.stderr, /COLLAB_AGENT_ID is set/)
    assert.match(result.stderr, /answered by the owner/)

    const still = w.claude.listApprovals({ pending_only: true })
    assert.equal(still.length, 1, 'the approval must still be pending')
    assert.equal(still[0].status, 'pending')
  } finally {
    w.cleanup()
  }
})

test('approve REFUSES without an interactive terminal', async () => {
  const w = scratch()
  try {
    const approval = await requestApproval(w.codex.ctx, { action: 'deploy the backend', reason: 'ship it' })
    // spawnSync gives pipes, not a tty — which is what any script has.
    const result = run(w.dir, ['approve', approval.id])
    assert.equal(result.status, 3)
    assert.match(result.stderr, /needs an interactive terminal/)
    assert.equal(w.claude.listApprovals({ pending_only: true })[0].status, 'pending')
  } finally {
    w.cleanup()
  }
})

test('doctor names what is unavailable and how to fix it', () => {
  const w = scratch()
  try {
    const result = run(w.dir, ['doctor'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /agents/)
    assert.match(result.stdout, /runners/)
    // Whether codex is installed on this machine or not, the report must be
    // definite about it rather than silent.
    assert.match(result.stdout, /codex\s+(ok|unavailable)/)
  } finally {
    w.cleanup()
  }
})

test('log prints the audit trail', async () => {
  const w = scratch()
  try {
    const task = await w.claude.createTask({ title: 'Audited', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const result = run(w.dir, ['log', '--tail', '10'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /task\.created/)
    assert.match(result.stdout, /task\.claimed/)
  } finally {
    w.cleanup()
  }
})

test('brief prints what an agent is told about itself', () => {
  const w = scratch()
  try {
    const result = run(w.dir, ['brief', 'codex'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /code_reviewer/)
    assert.match(result.stdout, /independent engineer/)
    // The briefing file is real and reachable, not just a config string.
    assert.match(result.stdout, /submit_review/)
  } finally {
    w.cleanup()
  }
})

test('an unknown command fails loudly rather than doing nothing', () => {
  const w = scratch()
  try {
    const result = run(w.dir, ['frobnicate'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unknown command/)
  } finally {
    w.cleanup()
  }
})
