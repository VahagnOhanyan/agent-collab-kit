// The owner closing tasks around the gates and reopening closed ones (domain/owner.mjs) — and agents still unable to
// do either. The owner's functions take the context directly, as the CLI and the panel's write path call them.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CODES } from '../src/errors.mjs'
import { ownerCloseTasks, ownerReopenTask } from '../src/domain/owner.mjs'
import { TOOLS } from '../src/mcp/tools.mjs'
import { apis, cleanEnv, runCli, sandbox } from './helpers.mjs'

function world() {
  const sbx = sandbox()
  return { sbx, ...apis(sbx), cleanup: sbx.cleanup }
}

test('closing an open task: the status, the mark, and everything that pointed at it', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Half-done work', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    await w.claude.addDelegation({ task_id: task.id, to: 'implementer', model: 'sonnet', level: 'L1', purpose: 'do the edit' })
    const { review } = await w.claude.requestReview({ task_id: task.id })
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'review')

    // Completed though the review never passed: the owner may, and the record says so.
    const result = await ownerCloseTasks(w.claude.ctx, { task_ids: [task.id], outcome: 'completed', reason: 'shipped by hand' })
    assert.deepEqual(result.closed.map((r) => [r.id, r.status, r.from_status]), [[task.id, 'completed', 'review']])

    const closed = w.claude.getTask({ task_id: task.id })
    assert.equal(closed.status, 'completed')
    assert.equal(closed.lease, null)
    assert.equal(closed.closed_by_owner.reason, 'shipped by hand')
    assert.equal(closed.closed_by_owner.from_status, 'review')
    assert.equal(closed.closed_by_owner.previous_owner, 'claude')
    assert.ok(closed.delegations.every((d) => d.finished_at && d.outcome.includes('shipped by hand')), 'no delegation left without an outcome')
    assert.equal(w.claude.store.get('reviews', review.id).verdict, 'released', 'the pending review is released')
    const told = w.claude.store.list('messages').filter((m) => m.task_id === task.id && m.from_agent === 'owner')
    assert.equal(told.length, 1, 'the holder is told')
    assert.match(told[0].body, /shipped by hand/)
  } finally {
    w.cleanup()
  }
})

test('closing denies a pending approval — never grants it', async () => {
  const w = world()
  try {
    const task = await w.codex.createTask({ title: 'Add live flight data', action: 'buy a subscription to the flight data API' })
    const approval = await w.codex.requestUserApproval({ task_id: task.id, action: 'buy a subscription to the flight data API', reason: 'needs live data', cost_estimate: 'about $49/month' })
    assert.equal(w.codex.getTask({ task_id: task.id }).status, 'waiting_for_user')

    const result = await ownerCloseTasks(w.claude.ctx, { task_ids: [task.id], outcome: 'cancelled', reason: 'not buying it' })
    assert.equal(result.closed[0].denied_approval, approval.id)
    assert.equal(w.claude.store.get('approvals', approval.id).status, 'denied')
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'cancelled')
  } finally {
    w.cleanup()
  }
})

test('a reason is required, and a batch is all or nothing', async () => {
  const w = world()
  try {
    const a = await w.claude.createTask({ title: 'Tidy the first module', action: 'edit a file' })
    const b = await w.claude.createTask({ title: 'Tidy the second module', action: 'edit a file' })
    for (const reason of ['', '   ', undefined]) {
      await assert.rejects(ownerCloseTasks(w.claude.ctx, { task_ids: [a.id], outcome: 'cancelled', reason }), (e) => e.code === CODES.INVALID_INPUT)
    }
    await assert.rejects(ownerCloseTasks(w.claude.ctx, { task_ids: [a.id], outcome: 'blocked', reason: 'x' }), (e) => e.code === CODES.INVALID_INPUT)

    await ownerCloseTasks(w.claude.ctx, { task_ids: [b.id], outcome: 'cancelled', reason: 'not needed' })
    // b is already closed: the batch is refused whole, and a stays open.
    await assert.rejects(ownerCloseTasks(w.claude.ctx, { task_ids: [a.id, b.id], outcome: 'cancelled', reason: 'tidy up' }), (e) => e.code === CODES.ILLEGAL_TRANSITION)
    assert.equal(w.claude.getTask({ task_id: a.id }).status, 'created')

    const both = await ownerCloseTasks(w.claude.ctx, { task_ids: [a.id], outcome: 'cancelled', reason: 'tidy up' })
    assert.equal(both.closed.length, 1)
  } finally {
    w.cleanup()
  }
})

test('reopening: back to the pool with nobody holding it, the history kept, the review gate back in force', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Closed too early', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    await ownerCloseTasks(w.claude.ctx, { task_ids: [task.id], outcome: 'completed', reason: 'looked done' })

    await assert.rejects(ownerReopenTask(w.claude.ctx, { task_id: task.id, reason: '' }), (e) => e.code === CODES.INVALID_INPUT)
    const reopened = await ownerReopenTask(w.claude.ctx, { task_id: task.id, reason: 'it was not' })
    assert.deepEqual([reopened.status, reopened.from_status], ['created', 'completed'])

    const t = w.claude.getTask({ task_id: task.id })
    assert.equal(t.owner, null)
    assert.equal(t.closed_by_owner, undefined, 'a reopened task no longer reads "closed by the owner"')
    assert.deepEqual(t.owner_history.map((h) => [h.action, h.reason]), [['closed', 'looked done'], ['reopened', 'it was not']])

    // An open task has nothing to reopen.
    await assert.rejects(ownerReopenTask(w.claude.ctx, { task_id: task.id, reason: 'again' }), (e) => e.code === CODES.ILLEGAL_TRANSITION)

    // Taken again and completed the agents' way: the review it needs is still required.
    await w.codex.claimTask({ task_id: task.id })
    await assert.rejects(w.codex.completeTask({ task_id: task.id, summary: 'done' }), (e) => e.code === CODES.GUARD_FAILED)
  } finally {
    w.cleanup()
  }
})

test('an approval earned before the close does not carry over a reopen', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Approved then reopened', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const { review } = await w.claude.requestReview({ task_id: task.id })
    await w.codex.submitReview({ review_id: review.id, verdict: 'approved', summary: 'Checked the one file it touches.' })
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'approved')
    await ownerCloseTasks(w.claude.ctx, { task_ids: [task.id], outcome: 'cancelled', reason: 'not now' })
    await ownerReopenTask(w.claude.ctx, { task_id: task.id, reason: 'now after all' })

    await w.claude.claimTask({ task_id: task.id })
    await assert.rejects(w.claude.completeTask({ task_id: task.id, summary: 'reuse the old approval' }), (e) => e.code === CODES.GUARD_FAILED)
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'in_progress')
  } finally {
    w.cleanup()
  }
})

test('agents still cannot: no tool for it, the state machine unchanged', async () => {
  const w = world()
  try {
    const names = TOOLS.map((tool) => tool.name)
    assert.ok(!names.some((name) => /close|reopen|owner/i.test(name)), `no owner action among the MCP tools: ${names.join(', ')}`)
    assert.equal(w.claude.ownerCloseTasks, undefined, 'not on the facade either')
    assert.equal(w.claude.ownerReopenTask, undefined)

    const task = await w.claude.createTask({ title: 'Needs a review', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    await assert.rejects(w.claude.completeTask({ task_id: task.id, summary: 'skip the review' }), (e) => e.code === CODES.GUARD_FAILED)

    const quick = await w.claude.createTask({ title: 'No review', action: 'edit a file', needs_review: false })
    await w.claude.claimTask({ task_id: quick.id })
    await w.claude.completeTask({ task_id: quick.id, summary: 'done' })
    const fresh = w.claude.getTask({ task_id: quick.id })
    await assert.rejects(w.claude.updateTask({ task_id: quick.id, status: 'created', expected_version: fresh.version }), (e) => e.code === CODES.ILLEGAL_TRANSITION)
  } finally {
    w.cleanup()
  }
})

test('collab close / reopen refuse an agent shell and a run without a terminal', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Left alone', action: 'edit a file' })
    const close = ['close', task.id, '--cancel', '--reason', 'not needed']
    const fromAgent = runCli(close, { cwd: w.sbx.root, env: cleanEnv({ COLLAB_AGENT_ID: 'codex' }), options: w.sbx.options })
    assert.equal(fromAgent.status, 3, fromAgent.stderr)
    assert.match(fromAgent.stderr, /agent's shell/)
    const noTerminal = runCli(close, { cwd: w.sbx.root, env: cleanEnv(), options: w.sbx.options })
    assert.equal(noTerminal.status, 3, noTerminal.stderr)
    assert.match(noTerminal.stderr, /interactive terminal/)
    const reopen = runCli(['reopen', task.id, '--reason', 'x'], { cwd: w.sbx.root, env: cleanEnv({ COLLAB_AGENT_ID: 'claude' }), options: w.sbx.options })
    assert.equal(reopen.status, 3)
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'created', 'nothing changed')
  } finally {
    w.cleanup()
  }
})
