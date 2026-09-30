import { test } from 'node:test'
import assert from 'node:assert/strict'

import { standstillOf } from '../standstill.mjs'
import { tasksView } from '../views.mjs'

const task = (over = {}) => ({ id: 'tsk_a', title: 'Do it', status: 'created', owner: null, ...over })
const code = (t, ctx) => standstillOf(t, ctx).code

test('a finished task has no standstill', () => {
  assert.equal(standstillOf(task({ status: 'completed' })), null)
  assert.equal(standstillOf(task({ status: 'cancelled' })), null)
})

test('created: nobody owns it vs assigned but not started', () => {
  assert.equal(standstillOf(task()).detail, 'не взята никем')
  assert.match(standstillOf(task({ status: 'assigned', owner: 'agent-a' })).detail, /agent-a/)
  assert.equal(code(task()), 'not_started')
})

test('blocked shows the recorded reason, or says there is none', () => {
  assert.equal(standstillOf(task({ status: 'blocked', blocked_reason: 'review never picked up' })).detail, 'review never picked up')
  assert.match(standstillOf(task({ status: 'blocked' })).detail, /не записана/)
})

test('waiting_for_user: a live approval vs only expired ones vs none found', () => {
  const t = task({ status: 'waiting_for_user' })
  const live = { id: 'apr_1', task_id: 'tsk_a', status: 'pending', expired: false, action: 'fix it' }
  const dead = { id: 'apr_2', task_id: 'tsk_a', status: 'pending', expired: true }
  assert.equal(code(t, { approvals: [live] }), 'awaiting_approval')
  assert.match(standstillOf(t, { approvals: [live] }).detail, /apr_1.*fix it/)
  assert.equal(code(t, { approvals: [dead] }), 'approval_expired')
  assert.equal(code(t, { approvals: [live, dead] }), 'awaiting_approval')
  // an approval of another task must not be blamed on this one
  assert.match(standstillOf(t, { approvals: [{ ...live, task_id: 'tsk_other' }] }).detail, /не найден/)
})

test('changes_requested counts the latest changes_requested review by severity', () => {
  const t = task({ status: 'changes_requested' })
  const old = { id: 'rev_old', task_id: 'tsk_a', verdict: 'changes_requested', submitted_at: '2026-09-01T00:00:00Z', findings: [{ severity: 'minor' }] }
  const latest = { id: 'rev_new', task_id: 'tsk_a', verdict: 'changes_requested', submitted_at: '2026-09-02T00:00:00Z', findings: [{ severity: 'major' }, { severity: 'major' }, { severity: 'nit' }] }
  const result = standstillOf(t, { reviews: [latest, old] })
  assert.equal(result.code, 'review_changes')
  assert.match(result.detail, /rev_new: major 2, nit 1/)
  assert.doesNotMatch(result.detail, /rev_old/)
})

test('changes_requested with a later approving round says the work is probably done', () => {
  const t = task({ status: 'changes_requested' })
  const r1 = { id: 'rev_1', task_id: 'tsk_a', verdict: 'changes_requested', submitted_at: '2026-09-01T00:00:00Z', findings: [{ severity: 'major' }] }
  const r2 = { id: 'rev_2', task_id: 'tsk_a', verdict: 'approved', submitted_at: '2026-09-02T00:00:00Z', findings: [] }
  const result = standstillOf(t, { reviews: [r1, r2] })
  assert.match(result.detail, /rev_2 одобрило/)
  assert.doesNotMatch(result.detail, /major/)
})

test('approved: ready to complete, unless the owner or the ux gate still holds it', () => {
  const t = task({ status: 'approved' })
  assert.equal(code(t), 'ready_to_complete')
  assert.equal(code(t, { approvals: [{ id: 'apr_1', task_id: 'tsk_a', status: 'pending' }] }), 'awaiting_approval')
  const ux = task({ status: 'approved', spec: { ux_impact: 'HIGH' } })
  const result = standstillOf(ux, { reviews: [] })
  assert.equal(result.code, 'ux_gate')
  assert.ok(result.obstacles.length === 1)
})

test('review lists the requests still waiting for a verdict', () => {
  const t = task({ status: 'review' })
  const open = { id: 'rev_1', task_id: 'tsk_a', requested_role: 'code_reviewer' }
  const done = { id: 'rev_2', task_id: 'tsk_a', requested_role: 'code_reviewer', submitted_at: '2026-09-02T00:00:00Z' }
  const result = standstillOf(t, { reviews: [open, done] })
  assert.equal(result.code, 'in_review')
  assert.match(result.detail, /rev_1/)
  assert.doesNotMatch(result.detail, /rev_2/)
})

test('in_progress and waiting_for_agent', () => {
  assert.equal(code(task({ status: 'in_progress' })), 'in_work')
  assert.match(standstillOf(task({ status: 'in_progress', needs_review: true })).detail, /ревью/)
  assert.equal(standstillOf(task({ status: 'waiting_for_agent', waiting_on: 'codex' })).detail, 'codex')
})

test('the list view attaches a standstill to every task without touching the rest', async () => {
  const tasks = [task({ id: 'tsk_a', status: 'blocked', blocked_reason: 'why' }), task({ id: 'tsk_b', status: 'completed' })]
  const api = { listTasks: async () => tasks, listReviews: () => [], listApprovals: () => [] }
  const shown = await tasksView(api, {})
  assert.equal(shown[0].standstill.code, 'blocked')
  assert.equal(shown[0].title, 'Do it')
  assert.equal(shown[1].standstill, null)
})
