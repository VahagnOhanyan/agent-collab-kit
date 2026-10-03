import { test } from 'node:test'
import assert from 'node:assert/strict'

import { overviewView, rosterView, taskView, waitingView } from '../views.mjs'
import { loadConfigFrom } from '../../collab/src/registry.mjs'

test('view projections preserve the endpoint contract without writing', async () => {
  const task = { id: 'tsk_one', title: 'Inspect my-app', status: 'in_progress', delegations: [{ id: 'd1' }] }
  const api = {
    status: async () => ({ journal_root: '/tmp/my-app', tasks: { open: 1 } }),
    doctor: () => ({ agents: [{ id: 'agent-a' }], unheld_roles: ['reviewer'], models: { vendors: [] } }),
    getTask: () => task,
    listTasks: async () => [task],
    listReviews: ({ pending_only } = {}) => pending_only ? [{ id: 'rev_one', task_id: task.id }] : [{ id: 'rev_one' }],
    // A message between two other agents must reach the task page; the lead the
    // panel reads as is not its addressee, and getMessages() would drop it.
    getMessages: async () => [],
    store: {
      list: (collection, { filter }) => {
        assert.equal(collection, 'messages')
        return [
          { id: 'msg_one', task_id: 'tsk_one', to: { agent: 'someone-else' } },
          { id: 'msg_two', task_id: 'tsk_one', to: { agent: 'agent-a' } },
          { id: 'msg_other', task_id: 'tsk_elsewhere', to: { agent: 'agent-a' } }
        ].filter(filter)
      }
    },
    listApprovals: () => [{ id: 'apr_one' }],
    listDecisions: () => [{ id: 'dec_one', status: 'disputed' }, { id: 'dec_two', status: 'resolved' }],
    listAgents: () => [{ id: 'agent-a', name: 'Agent A', provider: 'provider', roles: ['engineer'], capabilities: ['read'], runtime: { effective_status: 'available' } }],
    listModels: () => [{ level: 'L1' }],
    config: { agents: { lead: 'agent-a', review_mode: 'single_vendor' } },
    registry: { roles: () => ({ engineer: { summary: 'Builds.', requires: ['read'] } }) }
  }

  assert.equal((await overviewView(api)).initialized, true)
  const shown = await taskView(api, task.id)
  assert.equal(shown.standstill.code, 'in_work')
  delete shown.standstill
  assert.deepEqual(shown, {
    task,
    usage: null,
    branch: { tasks: 0, total: { input: 0, output: 0, cache_creation: 0, cache_read: 0 }, approximate: false, descendants: 0, none: true },
    parent: null,
    children: [],
    reviews: [{ id: 'rev_one' }],
    messages: [
      { id: 'msg_one', task_id: 'tsk_one', to: { agent: 'someone-else' } },
      { id: 'msg_two', task_id: 'tsk_one', to: { agent: 'agent-a' } }
    ],
    delegations: [{ id: 'd1' }]
  })
  const waiting = await waitingView(api)
  assert.deepEqual(waiting.decisions.map((decision) => decision.id), ['dec_one'])
  assert.deepEqual(waiting.reviews.map((review) => review.id), ['rev_one'])
  assert.equal(waiting.commands.approve, 'collab approve <id>')
  assert.equal(rosterView(api).agents[0].status, 'available')
})

test('a task page names the task it was created within and the tasks created within it, read from parent_task alone', async () => {
  const tasks = [
    { id: 'tsk_top', title: 'The top task', status: 'in_progress', owner: 'agent-a' },
    { id: 'tsk_mid', title: 'Created within the top', status: 'created', owner: null, parent_task: 'tsk_top' },
    { id: 'tsk_low', title: 'Created within the middle', status: 'completed', owner: 'agent-b', parent_task: 'tsk_mid' },
    { id: 'tsk_other', title: 'Unrelated', status: 'created', owner: null }
  ]
  const api = {
    getTask: ({ task_id }) => tasks.find((t) => t.id === task_id),
    listTasks: async () => tasks,
    listReviews: () => [],
    listApprovals: () => [],
    store: { list: () => [] }
  }
  const top = await taskView(api, 'tsk_top')
  assert.equal(top.parent, null)
  assert.deepEqual(top.children, [{ id: 'tsk_mid', title: 'Created within the top', status: 'created', owner: null }])
  const mid = await taskView(api, 'tsk_mid')
  assert.equal(mid.parent.id, 'tsk_top')
  assert.deepEqual(mid.children.map((c) => c.id), ['tsk_low'])
  const low = await taskView(api, 'tsk_low')
  assert.equal(low.parent.id, 'tsk_mid')
  assert.deepEqual(low.children, [])
})

test('a task waiting for the owner says what the owner can do now: approve a live request, or ask again / close', async () => {
  const tasks = [
    { id: 'tsk_live', title: 'Rotate the deploy key', status: 'waiting_for_user', action: 'rotate the api key', action_class: 'SECURITY_SENSITIVE', owner: 'agent-a' },
    { id: 'tsk_stale', title: 'Stage 2: model tests', status: 'waiting_for_user', action: 'Stage 2: model tests', action_class: 'SECURITY_SENSITIVE', owner: 'agent-b' },
    { id: 'tsk_bare', title: 'Asked without a request', status: 'waiting_for_user', action: 'x', action_class: 'DESTRUCTIVE', owner: 'agent-a' },
    { id: 'tsk_busy', title: 'Ordinary work', status: 'in_progress' }
  ]
  const approvals = [
    { id: 'apr_live', task_id: 'tsk_live', action_class: 'SECURITY_SENSITIVE', policy_reason: 'Credentials need the owner.', expired: false, expires_at: '2099-01-01T00:00:00Z' },
    { id: 'apr_stale', task_id: 'tsk_stale', action_class: 'SECURITY_SENSITIVE', policy_reason: 'nothing in the policy table matched, so it is treated as SECURITY_SENSITIVE', reason: 'Please let me start.', expired: true, expires_at: '2000-01-01T00:00:00Z' }
  ]
  const api = {
    listTasks: async ({ open } = {}) => (open ? tasks : tasks),
    listApprovals: ({ task_id } = {}) => approvals.filter((a) => !task_id || a.task_id === task_id),
    listDecisions: () => [],
    listReviews: () => [],
    config: { policy: loadConfigFrom().policy }
  }
  const waiting = await waitingView(api)
  assert.deepEqual(waiting.tasks.map((t) => [t.id, t.state, t.approval?.id || null]), [
    ['tsk_live', 'live', 'apr_live'],
    ['tsk_stale', 'expired', 'apr_stale'],
    ['tsk_bare', 'none', null]
  ])
  const stale = waiting.tasks.find((t) => t.id === 'tsk_stale')
  assert.match(stale.policy_reason, /nothing in the policy table matched/, 'the screen can tell a guess from a rule')
  assert.equal(stale.reason, 'Please let me start.')
  // Read again by the table in force: an unrecognised action says so; a key rotation is recognised as security.
  assert.equal(stale.now.recognised, false)
  assert.deepEqual([waiting.tasks[0].now.action_class, waiting.tasks[0].now.recognised], ['SECURITY_SENSITIVE', true])
  assert.equal(waiting.approvals.find((a) => a.id === 'apr_live').task_title, 'Rotate the deploy key')
})
