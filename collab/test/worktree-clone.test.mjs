// A task's working copy gets the ignored dependency trees it needs to run its
// own checks as copy-on-write clones (worktree-clone.mjs), configured per project
// by `worktree_clone` in the registry entry (project-settings.mjs).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { cloneIntoCopy } from '../src/worktree-clone.mjs'
import { sandbox, writeJson } from './helpers.mjs'

function trees() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-clone-')))
  const root = join(base, 'root')
  const copy = join(base, 'copy')
  mkdirSync(join(root, 'backend', 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'backend', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  mkdirSync(join(copy, 'backend'), { recursive: true })
  return { base, root, copy, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('on macOS the dependency tree is cloned and the clone is the copy\'s own', { skip: process.platform !== 'darwin' && 'clonefile is macOS-only' }, () => {
  const t = trees()
  try {
    const [r] = cloneIntoCopy({ codeRoot: t.root, copyDir: t.copy, paths: ['backend/node_modules'] })
    assert.equal(r.status, 'cloned', r.detail)
    const cloned = join(t.copy, 'backend', 'node_modules', 'pkg', 'index.js')
    assert.equal(readFileSync(cloned, 'utf8'), 'module.exports = 1\n')
    // a change in the copy does not reach the main tree (unlike a symlink)
    writeFileSync(cloned, 'module.exports = 2\n')
    assert.equal(readFileSync(join(t.root, 'backend', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports = 1\n')
  } finally {
    t.cleanup()
  }
})

test('missing source, existing target, missing parent and another platform are reported, not copied', () => {
  const t = trees()
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args])
    return { status: 0, stderr: '' }
  }
  try {
    mkdirSync(join(t.root, 'web', 'node_modules'), { recursive: true })
    mkdirSync(join(t.root, 'rail-router', 'node_modules'), { recursive: true })
    mkdirSync(join(t.copy, 'rail-router', 'node_modules'), { recursive: true })
    const results = cloneIntoCopy({
      codeRoot: t.root,
      copyDir: t.copy,
      paths: ['nope/node_modules', 'rail-router/node_modules', 'web/node_modules'],
      platform: 'darwin',
      run,
    })
    assert.deepEqual(results.map((r) => r.status), ['missing', 'exists', 'missing'])
    assert.equal(calls.length, 0)
    const linux = cloneIntoCopy({ codeRoot: t.root, copyDir: t.copy, paths: ['backend/node_modules'], platform: 'linux', run })
    assert.equal(linux[0].status, 'unsupported')
    assert.equal(calls.length, 0, 'no full copy where the file system cannot clone')
  } finally {
    t.cleanup()
  }
})

test('a failed clone is reported with its reason', () => {
  const t = trees()
  try {
    const [r] = cloneIntoCopy({
      codeRoot: t.root,
      copyDir: t.copy,
      paths: ['backend/node_modules'],
      platform: 'darwin',
      run: () => ({ status: 1, stderr: 'cp: clonefile failed: Operation not supported' }),
    })
    assert.equal(r.status, 'failed')
    assert.match(r.detail, /clonefile failed/)
  } finally {
    t.cleanup()
  }
})

test('worktree_clone is read from the registry entry and an escaping path is a configuration error', async () => {
  const sbx = sandbox()
  const registryDir = join(sbx.base, 'registry')
  try {
    writeJson(join(registryDir, 'proj', 'project.json'), { id: 'proj', roots: [sbx.root], worktree_clone: ['backend/node_modules/', 'web/node_modules'] })
    const api = createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir, registryDir })
    assert.deepEqual(api.projectSettings().worktree_clone, ['backend/node_modules', 'web/node_modules'])
    writeJson(join(registryDir, 'proj', 'project.json'), { id: 'proj', roots: [sbx.root], worktree_clone: ['../outside'] })
    assert.throws(() => api.projectSettings(), (e) => e.code === CODES.CONFIG_INVALID)
  } finally {
    sbx.cleanup()
  }
})
