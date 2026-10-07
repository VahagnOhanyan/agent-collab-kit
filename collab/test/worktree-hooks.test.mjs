// Per-task resources beside a task copy (a test database of its own): the
// project's worktree_hooks commands, run without a shell (worktree-hooks.mjs).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { runWorktreeHooks } from '../src/worktree-hooks.mjs'
import { sandbox, writeJson } from './helpers.mjs'

test('placeholders are substituted per argv element and nothing goes through a shell', () => {
  const calls = []
  const run = (argv, cwd) => {
    calls.push({ argv, cwd })
    return { status: 0, stderr: '' }
  }
  const results = runWorktreeHooks({
    commands: [['createdb', '-T', 'app_test', 'app_test_{task}'], ['echo', '{copy};rm -rf /']],
    task: 'tsk_abc_123',
    copy: '/w/copy',
    cwd: '/root',
    run,
  })
  assert.deepEqual(calls.map((c) => c.argv), [['createdb', '-T', 'app_test', 'app_test_tsk_abc_123'], ['echo', '/w/copy;rm -rf /']])
  assert.equal(calls[0].cwd, '/root')
  assert.deepEqual(results.map((r) => r.status), ['ok', 'ok'])
})

test('a failing command is reported with its reason, the rest still run', () => {
  let n = 0
  const results = runWorktreeHooks({
    commands: [['a'], ['b']],
    task: 'tsk_x',
    copy: '/c',
    cwd: '/r',
    run: () => (n++ === 0 ? { status: 1, stderr: 'database already exists\n' } : { status: 0, stderr: '' }),
  })
  assert.deepEqual(results.map((r) => r.status), ['failed', 'ok'])
  assert.equal(results[0].detail, 'database already exists')
})

test('an unsafe task id is never substituted', () => {
  let ran = false
  const results = runWorktreeHooks({ commands: [['x', '{task}']], task: 'tsk; drop', copy: '/c', cwd: '/r', run: () => { ran = true; return { status: 0 } } })
  assert.equal(ran, false)
  assert.equal(results[0].status, 'skipped')
})

test('worktree_hooks is read from the registry entry and a malformed one is a configuration error', () => {
  const sbx = sandbox()
  const registryDir = join(sbx.base, 'registry')
  try {
    const api = createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir, registryDir })
    writeJson(join(registryDir, 'proj', 'project.json'), { id: 'proj', roots: [sbx.root] })
    assert.deepEqual(api.projectSettings().worktree_hooks, { add: [], remove: [] })
    writeJson(join(registryDir, 'proj', 'project.json'), { id: 'proj', roots: [sbx.root], worktree_hooks: { add: [['createdb', 'x_{task}']], remove: [['dropdb', 'x_{task}']] } })
    assert.deepEqual(api.projectSettings().worktree_hooks.add, [['createdb', 'x_{task}']])
    for (const bad of [{ add: 'createdb' }, { add: [[]] }, { setup: [['x']] }, { remove: [['ok', '']] }]) {
      writeJson(join(registryDir, 'proj', 'project.json'), { id: 'proj', roots: [sbx.root], worktree_hooks: bad })
      assert.throws(() => api.projectSettings(), (e) => e.code === CODES.CONFIG_INVALID, JSON.stringify(bad))
    }
  } finally {
    sbx.cleanup()
  }
})
