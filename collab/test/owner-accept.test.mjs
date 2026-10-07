// `collab task accept <id> --reason "…"` (domain/owner.mjs ownerAcceptTask): the owner taking work whose review
// gate is stuck behind a verdict they decided to override — and agents unable to do it themselves. As with
// owner-close, the domain function takes the context directly, the way the CLI calls it; the interactive confirmation
// (the id typed back at a terminal) is the CLI's and cannot be driven without one, so what is tested here is the
// record it writes and every refusal around it.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CODES } from '../src/errors.mjs'
import { ownerAcceptTask } from '../src/domain/owner.mjs'
import { TOOLS } from '../src/mcp/tools.mjs'
import { apis, cleanEnv, runCli, sandbox } from './helpers.mjs'

function world() {
  const sbx = sandbox()
  return { sbx, ...apis(sbx), cleanup: sbx.cleanup }
}

async function changesRequestedTask(w, title = 'Work the reviewer disliked') {
  const task = await w.claude.createTask({ title, action: 'edit a file' })
  await w.claude.claimTask({ task_id: task.id })
  const { review } = await w.claude.requestReview({ task_id: task.id })
  await w.codex.submitReview({ review_id: review.id, verdict: 'changes_requested', summary: 'no', findings: [{ severity: 'minor', note: 'about code the change merely touched' }] })
  assert.equal(w.claude.getTask({ task_id: task.id }).status, 'changes_requested')
  return { task, review }
}

test('accepting a task in changes_requested completes it and records the owner\'s decision and the verdict it overrode', async () => {
  const w = world()
  try {
    const { task, review } = await changesRequestedTask(w)
    await w.claude.addDelegation({ task_id: task.id, to: 'implementer', model: 'sonnet', level: 'L1', purpose: 'the edit' })

    const result = await ownerAcceptTask(w.claude.ctx, { task_id: task.id, reason: 'the findings are about untouched code; ship it' })
    assert.deepEqual([result.status, result.from_status, result.last_review_verdict], ['completed', 'changes_requested', 'changes_requested'])

    const done = w.claude.getTask({ task_id: task.id })
    assert.equal(done.status, 'completed')
    assert.equal(done.lease, null)
    assert.equal(done.owner_decision.reason, 'the findings are about untouched code; ship it')
    assert.equal(done.owner_decision.last_review_verdict, 'changes_requested')
    assert.equal(done.owner_decision.from_status, 'changes_requested')
    assert.ok(done.owner_decision.at)
    assert.equal(done.closed_by_owner, undefined, 'it is not a forced close: the record says "accepted"')
    assert.equal(done.owner_history.at(-1).action, 'accepted')
    assert.ok(done.delegations.every((d) => d.finished_at), 'no delegation left without an outcome')
    assert.equal(w.claude.store.get('reviews', review.id).verdict, 'changes_requested', 'the review itself is not rewritten')
    const told = w.claude.store.list('messages').filter((m) => m.task_id === task.id && m.from_agent === 'owner')
    assert.equal(told.length, 1)
    assert.match(told[0].body, /ship it/)
  } finally {
    w.cleanup()
  }
})

test('a task sent back to work after the verdict (in_progress) can be accepted too, and a pending review is released', async () => {
  const w = world()
  try {
    const { task } = await changesRequestedTask(w)
    await w.claude.updateTask({ task_id: task.id, status: 'in_progress', expected_version: w.claude.getTask({ task_id: task.id }).version })
    const asked = await w.claude.requestReview({ task_id: task.id, blocking: false, slot: 'tests' })
    const result = await ownerAcceptTask(w.claude.ctx, { task_id: task.id, reason: 'accepted as it is' })
    assert.deepEqual(result.released_reviews, [asked.review.id])
    assert.equal(w.claude.store.get('reviews', asked.review.id).verdict, 'released')
    assert.equal(w.claude.getTask({ task_id: task.id }).owner_decision.last_review_verdict, 'changes_requested')
  } finally {
    w.cleanup()
  }
})

test('refusals: no reason, nothing to accept, a status it does not apply to, an unanswered approval', async () => {
  const w = world()
  try {
    const { task } = await changesRequestedTask(w)
    for (const reason of [undefined, '', '  ']) {
      await assert.rejects(ownerAcceptTask(w.claude.ctx, { task_id: task.id, reason }), (e) => e.code === CODES.INVALID_INPUT, JSON.stringify(reason))
    }
    await assert.rejects(ownerAcceptTask(w.claude.ctx, { task_id: 'tsk_mf3k2p_a91c04', reason: 'x' }), (e) => e.code === CODES.NOT_FOUND)
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'changes_requested', 'refusals changed nothing')

    // no review gate: nothing to accept
    const quick = await w.claude.createTask({ title: 'No review', action: 'edit a file', needs_review: false })
    await w.claude.claimTask({ task_id: quick.id })
    await assert.rejects(ownerAcceptTask(w.claude.ctx, { task_id: quick.id, reason: 'x' }), (e) => e.code === CODES.INVALID_INPUT && /no review gate/.test(e.message))

    // in review (a verdict is still expected) and approved (completes the ordinary way): not for accept
    const inReview = await w.claude.createTask({ title: 'Waiting for the reviewer', action: 'edit a file' })
    await w.claude.claimTask({ task_id: inReview.id })
    await w.claude.requestReview({ task_id: inReview.id })
    await assert.rejects(ownerAcceptTask(w.claude.ctx, { task_id: inReview.id, reason: 'x' }), (e) => e.code === CODES.ILLEGAL_TRANSITION)

    // waiting for the owner's answer to an approval: that question comes first
    const costly = await w.codex.createTask({ title: 'Add live flight data', action: 'buy a subscription to the flight data API' })
    await w.codex.requestUserApproval({ task_id: costly.id, action: 'buy a subscription to the flight data API', reason: 'needs live data', cost_estimate: 'about $49/month' })
    await assert.rejects(ownerAcceptTask(w.claude.ctx, { task_id: costly.id, reason: 'x' }), (e) => e.code === CODES.INVALID_INPUT && /approval/.test(e.message))
    assert.equal(w.claude.getTask({ task_id: costly.id }).status, 'waiting_for_user')

    // already closed
    await ownerAcceptTask(w.claude.ctx, { task_id: task.id, reason: 'fine' })
    await assert.rejects(ownerAcceptTask(w.claude.ctx, { task_id: task.id, reason: 'again' }), (e) => e.code === CODES.ILLEGAL_TRANSITION)
  } finally {
    w.cleanup()
  }
})

test('agents cannot accept: no MCP tool, nothing on the facade, and the command refuses an agent shell and a run without a terminal', async () => {
  const w = world()
  try {
    const names = TOOLS.map((tool) => tool.name)
    assert.ok(!names.some((name) => /accept/i.test(name)), `no accept among the MCP tools: ${names.join(', ')}`)
    assert.equal(w.claude.ownerAcceptTask, undefined)

    const { task } = await changesRequestedTask(w)
    const accept = ['task', 'accept', task.id, '--reason', 'the owner decides']
    const fromAgent = runCli(accept, { cwd: w.sbx.root, env: cleanEnv({ COLLAB_AGENT_ID: 'claude' }), options: w.sbx.options })
    assert.equal(fromAgent.status, 3, fromAgent.stderr)
    assert.match(fromAgent.stderr, /agent's shell/)
    const noTerminal = runCli(accept, { cwd: w.sbx.root, env: cleanEnv(), options: w.sbx.options })
    assert.equal(noTerminal.status, 3, noTerminal.stderr)
    assert.match(noTerminal.stderr, /interactive terminal/)
    const noReason = runCli(['task', 'accept', task.id], { cwd: w.sbx.root, env: cleanEnv(), options: w.sbx.options })
    assert.equal(noReason.status, 1)
    assert.match(noReason.stderr, /--reason/)
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'changes_requested', 'nothing changed')
    assert.equal(w.claude.getTask({ task_id: task.id }).owner_decision, undefined)
  } finally {
    w.cleanup()
  }
})

test('plain `collab task <id>` still shows a task', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Just a task', action: 'edit a file' })
    const shown = runCli(['task', task.id], { cwd: w.sbx.root, env: cleanEnv(), options: w.sbx.options })
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(shown.stdout, /Just a task/)
  } finally {
    w.cleanup()
  }
})
