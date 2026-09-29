import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { createApi } from '../src/api.mjs'
import { sandbox } from './helpers.mjs'

const WRITES = [
  'createTask', 'claimTask', 'assignTask', 'updateTask', 'completeTask', 'blockTask', 'releaseTask', 'claimFiles',
  'addDelegation', 'completeDelegation', 'sweep', 'sendMessage', 'ackMessage', 'replyMessage', 'requestReview',
  'submitReview', 'releaseReview', 'createDecision', 'addPosition', 'resolveDecision', 'escalateDecision',
  'requestUserApproval', 'startRun', 'setStatus'
]

function digest(root) {
  const hash = createHash('sha256')
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name)
      const stat = statSync(file)
      hash.update(relative(root, file))
      if (stat.isDirectory()) visit(file)
      else hash.update(readFileSync(file))
    }
  }
  visit(root)
  return hash.digest('hex')
}

test('readOnly createApi disables sweeping and every listed write method', async (t) => {
  const sbx = sandbox()
  t.after(sbx.cleanup)
  const api = createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir, readOnly: true })
  const before = digest(sbx.stateDir)

  await api.status()
  await api.listTasks()
  await api.getMessages()
  assert.equal(digest(sbx.stateDir), before)

  for (const method of WRITES) {
    assert.throws(() => api[method]({}), (error) => error?.code === 'READ_ONLY', method)
  }
  assert.equal(digest(sbx.stateDir), before)
})

test('createApi without readOnly retains write behaviour', async (t) => {
  const sbx = sandbox()
  t.after(sbx.cleanup)
  const api = createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir })
  const task = await api.createTask({ title: 'Read-write API', description: 'Existing callers can still create tasks.', role: 'software_engineer' })
  assert.equal(api.getTask({ task_id: task.id }).title, 'Read-write API')
})
