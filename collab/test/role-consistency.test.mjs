// The roster and the roles work is asked of must agree: nothing is created, sent,
// assigned or reviewed for a role that no registered agent holds, and work that
// was created before the composition changed is named instead of waiting.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { planComposition, writeComposition } from '../src/composition.mjs'
import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
import { loadBuiltinAgents, loadConfigFrom } from '../src/registry.mjs'
import { sandbox, tempDir, writeJson } from './helpers.mjs'

function machine(include = ['claude', 'codex']) {
  const base = tempDir('collab-role-consistency-')
  const dir = join(base, 'machine')
  const planned = planComposition({ catalog: loadBuiltinAgents(), roleDefs: loadConfigFrom().roles.roles, include, lead: include[0] })
  writeComposition(dir, planned.content, { catalogDir: DEFAULT_CONFIG_DIR })
  return { base, dir, content: planned.content }
}

const apiFor = (m, sbx, agentId = 'claude') => createApi({ agentId, roots: sbx.roots, machineDir: m.dir, registryDir: join(m.base, 'no-registry') })

test('a task for a role nobody holds is refused when it is created, and one for a held role is fine', async () => {
  const m = machine()
  const sbx = sandbox()
  try {
    const api = apiFor(m, sbx)
    await assert.rejects(
      async () => api.createTask({ title: 'Look at the auth change', role: 'security_reviewer', action: 'edit a file' }),
      (e) => e.code === CODES.NO_AGENT_AVAILABLE && /security_reviewer/.test(e.message)
    )
    assert.equal((await api.status()).tasks.open, 0, 'nothing was created')
    const ok = await api.createTask({ title: 'Ordinary review', role: 'code_reviewer', action: 'edit a file' })
    assert.equal(ok.role, 'code_reviewer')
    const free = await api.createTask({ title: 'No role at all', action: 'edit a file' })
    assert.equal(free.role, null)
  } finally {
    rmSync(m.base, { recursive: true, force: true })
    sbx.cleanup()
  }
})

test('the other ways of asking a vacant role stay refused: a review, a message and an assignment', async () => {
  const m = machine()
  const sbx = sandbox()
  try {
    const api = apiFor(m, sbx)
    const task = await api.createTask({ title: 'Some work', action: 'edit a file' })
    await api.claimTask({ task_id: task.id })
    await assert.rejects(api.requestReview({ task_id: task.id, reviewer_role: 'security_reviewer' }), (e) => e.code === CODES.NO_AGENT_AVAILABLE)
    await assert.rejects(
      async () => api.sendMessage({ to_role: 'security_reviewer', subject: 'hello', body: 'anyone?' }),
      (e) => /nobody registered holds/.test(e.message)
    )
    await assert.rejects(async () => api.assignTask({ task_id: task.id, role: 'security_reviewer' }), (e) => e.code === CODES.NO_AGENT_AVAILABLE)
    assert.equal((await api.getTask({ task_id: task.id })).status, 'in_progress', 'the task did not move')
  } finally {
    rmSync(m.base, { recursive: true, force: true })
    sbx.cleanup()
  }
})

test('doctor names open work whose role lost its holder when the composition changed', async () => {
  const m = machine()
  const sbx = sandbox()
  try {
    const before = apiFor(m, sbx)
    const task = await before.createTask({ title: 'Tests for the map', role: 'test_engineer', action: 'edit a file' })
    assert.deepEqual(before.doctor().orphaned_tasks, [])
    // The person re-sets the composition to Claude alone: nobody holds test_engineer any more.
    const alone = machine(['claude'])
    rmSync(alone.base, { recursive: true, force: true })
    writeJson(join(m.dir, 'agents.json'), { ...m.content, agents: m.content.agents.filter((a) => a.id === 'claude').map((a) => ({ ...a, roles: a.roles.filter((r) => r !== 'test_engineer') })) })
    const after = apiFor(m, sbx)
    const report = after.doctor()
    assert.deepEqual(report.orphaned_tasks.map((t) => [t.id, t.role]), [[task.id, 'test_engineer']])
    assert.ok(report.unheld_roles.includes('test_engineer'))
  } finally {
    rmSync(m.base, { recursive: true, force: true })
    sbx.cleanup()
  }
})
