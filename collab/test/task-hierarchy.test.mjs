// A task created within another remembers it, a task says which model it is worked on with, and a plan's route is
// kept as data beside what happened. All three are RECORDS (see delegations.mjs): none of them starts or checks an agent.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { fixedClock } from '../src/ids.mjs'
import { sandbox } from './helpers.mjs'

function world() {
  const sbx = sandbox()
  const clock = fixedClock()
  const make = (agentId) => createApi({ agentId, roots: sbx.roots, configDir: sbx.configDir, clock })
  return { claude: make('claude'), codex: make('codex'), cleanup: sbx.cleanup }
}

const make = (api, title) => api.createTask({ title, action: 'edit a file' })

test('a task created while its author holds exactly one task becomes that task\'s child', async () => {
  const w = world()
  try {
    const parent = await make(w.claude, 'The parent task')
    await w.claude.claimTask({ task_id: parent.id })
    const child = await make(w.claude, 'Created within the parent')
    assert.equal(child.parent_task, parent.id)
    assert.equal(parent.parent_task, null, 'the first task has nobody above it')
  } finally {
    w.cleanup()
  }
})

test('an author with no task, or with two, gets no guessed parent', async () => {
  const w = world()
  try {
    const loose = await make(w.claude, 'Created while holding nothing')
    assert.equal(loose.parent_task, null)

    const a = await make(w.claude, 'Held task number one')
    const b = await make(w.claude, 'Held task number two')
    await w.claude.claimTask({ task_id: a.id })
    await w.claude.claimTask({ task_id: b.id })
    const child = await make(w.claude, 'Created while holding two')
    assert.equal(child.parent_task, null, 'two live tasks make the parent ambiguous, and a guess would hang it under the wrong branch')
  } finally {
    w.cleanup()
  }
})

test('a parent named by the caller wins, and one that does not exist is refused', async () => {
  const w = world()
  try {
    const held = await make(w.claude, 'The task being held')
    const named = await make(w.claude, 'The task named as parent')
    await w.claude.claimTask({ task_id: held.id })
    const child = await w.claude.createTask({ title: 'Created under a named parent', action: 'edit a file', parent_task: named.id })
    assert.equal(child.parent_task, named.id)

    await assert.rejects(
      async () => w.claude.createTask({ title: 'Created under nothing', action: 'edit a file', parent_task: 'tsk_mf3k2p_a91c04' }),
      (error) => error.code === CODES.INVALID_INPUT
    )
  } finally {
    w.cleanup()
  }
})

test('the model a task is claimed with is recorded, and survives a claim that names none', async () => {
  const w = world()
  try {
    const task = await make(w.claude, 'A task with a working model')
    const claimed = await w.claude.claimTask({ task_id: task.id, model: 'a-model-nobody-registered' })
    assert.equal(claimed.task.working_model.model, 'a-model-nobody-registered')
    assert.equal(claimed.task.working_model.model_known, false, 'an unknown name is kept and marked, not refused')
    assert.equal(claimed.task.working_model.by, 'claude')

    const again = await w.claude.claimTask({ task_id: task.id })
    assert.equal(again.task.working_model?.model ?? claimed.task.working_model.model, 'a-model-nobody-registered')

    const bare = await make(w.claude, 'A task claimed without naming a model')
    const none = await w.claude.claimTask({ task_id: bare.id })
    assert.equal(none.task.working_model, null, 'no model named means none on record, not a guess')
  } finally {
    w.cleanup()
  }
})

test('a planned route is kept as data, and a malformed one is refused', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({
      title: 'A task with a planned route',
      action: 'edit a file',
      spec: { route: [{ step: 'recon', agent: 'Explore', model: 'haiku', level: 'L0' }, { step: 'implementation', agent: 'claude' }] }
    })
    assert.equal(task.spec.route.length, 2)
    assert.deepEqual(task.spec.route[0], { step: 'recon', agent: 'Explore', model: 'haiku', level: 'L0' })
    assert.deepEqual(task.spec.route[1], { step: 'implementation', agent: 'claude' })

    for (const bad of [[{ agent: 'claude' }], [{ step: 'x', owner: 'y' }], [{ step: 'x', level: 'L9' }], 'not a list']) {
      await assert.rejects(
        async () => w.claude.createTask({ title: 'A task with a broken route', action: 'edit a file', spec: { route: bad } }),
        (error) => error.code === CODES.INVALID_INPUT,
        JSON.stringify(bad)
      )
    }
  } finally {
    w.cleanup()
  }
})
