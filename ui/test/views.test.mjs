import { test } from 'node:test'
import assert from 'node:assert/strict'

import { overviewView, rosterView, taskView, waitingView } from '../views.mjs'

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
