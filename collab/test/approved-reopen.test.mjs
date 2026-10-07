// approved -> in_progress: the way back into work that keeps the approval (transitions.mjs). A fix made while
// carrying approved work into the base is a correction of what was reviewed, so it needs a reason, leaves a mark,
// and completes without a second review — but only while the last gating review is still approved, and never after
// the task has gone through `review` again.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CODES } from '../src/errors.mjs'
import { TASK_STATUS, TRANSITIONS, assertTransition, canTransition } from '../src/transitions.mjs'
import { apis, sandbox } from './helpers.mjs'

const S = TASK_STATUS

function world() {
  const sbx = sandbox()
  return { sbx, ...apis(sbx), cleanup: sbx.cleanup }
}

// A task claude worked on and codex approved.
async function approvedTask(w) {
  const task = await w.claude.createTask({ title: 'Carry the fix into main', action: 'edit a file' })
  await w.claude.claimTask({ task_id: task.id })
  const { review } = await w.claude.requestReview({ task_id: task.id })
  await w.codex.submitReview({ review_id: review.id, verdict: 'approved', summary: 'fine' })
  assert.equal(w.claude.getTask({ task_id: task.id }).status, 'approved')
  return { task, review }
}

const back = (w, task, fields = {}) =>
  w.claude.updateTask({ task_id: task.id, status: 'in_progress', expected_version: w.claude.getTask({ task_id: task.id }).version, ...fields })

test('the table: approved has an edge to in_progress, and the guard asks for a reason first', () => {
  assert.ok(canTransition(S.APPROVED, S.IN_PROGRESS))
  assert.ok(TRANSITIONS[S.APPROVED].includes(S.COMPLETED), 'completing straight from approved is unchanged')
  const task = { id: 'tsk_1', status: S.APPROVED, needs_review: true, owner: 'claude' }
  const admission = { task_id: 'tsk_1' }
  for (const reason of [undefined, '', '   ']) {
    assert.throws(
      () => assertTransition(task, S.IN_PROGRESS, { admission, reason }),
      (e) => e.code === CODES.GUARD_FAILED && /returning an approved task to work requires a reason/.test(e.message),
      JSON.stringify(reason)
    )
  }
  assert.equal(assertTransition(task, S.IN_PROGRESS, { admission, reason: 'conflict while rebasing' }), S.IN_PROGRESS)
  // the reason is asked of THIS edge only: other ways into work are unchanged
  assert.equal(assertTransition({ ...task, status: S.WAITING_FOR_AGENT }, S.IN_PROGRESS, { admission }), S.IN_PROGRESS)
})

test('the table: completing from in_progress without a review is allowed only for a reopened task whose last gating review is approved', () => {
  const approved = { id: 'tsk_1', task_id: 'tsk_1', blocking: true, verdict: 'approved', submitted_at: '2026-10-07T10:00:00.000Z' }
  const plain = { id: 'tsk_1', status: S.IN_PROGRESS, needs_review: true, owner: 'claude' }
  const marked = { ...plain, reopened_after_approval: { at: 'x', reason: 'r', review_id: 'rev_1' } }
  const refuses = (task, reviews) => assert.throws(() => assertTransition(task, S.COMPLETED, { reviews }), (e) => e.code === CODES.GUARD_FAILED && /needs a review/.test(e.message))

  refuses(plain, [approved]) // an approval alone is not enough: nobody reopened it
  assert.equal(assertTransition(marked, S.COMPLETED, { reviews: [approved] }), S.COMPLETED)
  refuses(marked, []) // the mark without the review it stands on
  refuses(marked, [{ ...approved, verdict: 'changes_requested' }])
  // a slot beside the gate, or a review not yet answered, is not the gating verdict
  refuses(marked, [{ ...approved, blocking: false }])
  refuses(marked, [{ ...approved, submitted_at: null, verdict: 'pending' }])
  // the LAST gating verdict counts: an older approval does not outlive a later changes_requested
  refuses(marked, [approved, { ...approved, id: 'rev_2', verdict: 'changes_requested', submitted_at: '2026-10-07T11:00:00.000Z' }])
})

test('without a reason an approved task cannot go back to work; with one it can, and carries the mark', async () => {
  const w = world()
  try {
    const { task, review } = await approvedTask(w)
    await assert.rejects(back(w, task), (e) => e.code === CODES.GUARD_FAILED && /requires a reason/.test(e.message))
    await assert.rejects(back(w, task, { reason: '  ' }), (e) => e.code === CODES.GUARD_FAILED)
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'approved', 'a refused attempt changed nothing')

    const reopened = await back(w, task, { reason: 'rebase conflict in the album view' })
    assert.equal(reopened.status, 'in_progress')
    assert.equal(reopened.reopened_after_approval.reason, 'rebase conflict in the album view')
    assert.equal(reopened.reopened_after_approval.review_id, review.id)
    assert.equal(reopened.reopened_after_approval.by, 'claude')
  } finally {
    w.cleanup()
  }
})

test('after the correction the task completes without a new review', async () => {
  const w = world()
  try {
    const { task } = await approvedTask(w)
    await back(w, task, { reason: 'integration check found a stale import' })
    const done = await w.claude.completeTask({ task_id: task.id, summary: 'fixed the import while carrying it into main' })
    assert.equal(done.status, 'completed')
    assert.equal(done.reopened_after_approval.reason, 'integration check found a stale import', 'the mark stays as history')
  } finally {
    w.cleanup()
  }
})

test('a task that was never approved gets no such way: in_progress still needs a review to complete', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Plain work', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    await assert.rejects(w.claude.completeTask({ task_id: task.id, summary: 'skip' }), (e) => e.code === CODES.GUARD_FAILED && /needs a review/.test(e.message))
  } finally {
    w.cleanup()
  }
})

test('asking for a review again clears the mark: it is new work, and only a new approval completes it', async () => {
  const w = world()
  try {
    const { task } = await approvedTask(w)
    await back(w, task, { reason: 'bigger change than a fix' })
    assert.ok(w.claude.getTask({ task_id: task.id }).reopened_after_approval)

    const { review } = await w.claude.requestReview({ task_id: task.id })
    const inReview = w.claude.getTask({ task_id: task.id })
    assert.equal(inReview.status, 'review')
    assert.equal(inReview.reopened_after_approval, null)

    // the reviewer sends it back; the author works on it — the old approval does not come back with the mark
    await w.codex.submitReview({ review_id: review.id, verdict: 'changes_requested', summary: 'no', findings: [{ severity: 'major', note: 'broken' }] })
    await w.claude.updateTask({ task_id: task.id, status: 'in_progress', expected_version: w.claude.getTask({ task_id: task.id }).version })
    await assert.rejects(w.claude.completeTask({ task_id: task.id, summary: 'x' }), (e) => e.code === CODES.GUARD_FAILED && /needs a review/.test(e.message))
  } finally {
    w.cleanup()
  }
})

test('moving to review by status clears the mark as well', async () => {
  const w = world()
  try {
    const { task } = await approvedTask(w)
    await back(w, task, { reason: 'fix' })
    const moved = await w.claude.updateTask({ task_id: task.id, status: 'review', expected_version: w.claude.getTask({ task_id: task.id }).version })
    assert.equal(moved.status, 'review')
    assert.equal(moved.reopened_after_approval, null)
  } finally {
    w.cleanup()
  }
})

test('only the holder may take an approved task back to work', async () => {
  const w = world()
  try {
    const { task } = await approvedTask(w)
    await assert.rejects(
      w.codex.updateTask({ task_id: task.id, status: 'in_progress', expected_version: w.claude.getTask({ task_id: task.id }).version, reason: 'not mine' }),
      (e) => e.code === CODES.NOT_PERMITTED
    )
  } finally {
    w.cleanup()
  }
})
