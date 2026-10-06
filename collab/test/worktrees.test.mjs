// Parallel work: a task's working copy on record, the other half of a claim
// (release_files), shared infrastructure that is requested rather than claimed,
// and findings that must be re-read before a fix starts from a later commit.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { sandbox, writeJson } from './helpers.mjs'

function world({ sharedInfra = null, worktreesDir = null } = {}) {
  const sbx = sandbox()
  const registryDir = join(sbx.base, 'registry')
  if (sharedInfra || worktreesDir) {
    const entry = { id: 'proj', roots: [sbx.root] }
    if (sharedInfra) entry.shared_infra = sharedInfra
    if (worktreesDir) entry.worktrees_dir = worktreesDir
    writeJson(join(registryDir, 'proj', 'project.json'), entry)
  }
  const make = (agentId) => createApi({ agentId, roots: sbx.roots, configDir: sbx.configDir, registryDir })
  return { sbx, claude: make('claude'), codex: make('codex'), cleanup: sbx.cleanup }
}

const rejects = async (fn, code) => {
  let error = null
  try {
    await fn()
  } catch (e) {
    error = e
  }
  assert.ok(error, 'expected an error')
  assert.equal(error.code, code, error.message)
  return error
}

test('release_files gives back part of a claim, and the other task can take it at once', async () => {
  const w = world()
  try {
    const mine = await w.claude.createTask({ title: 'Audit the album', action: 'edit a file' })
    await w.claude.claimTask({ task_id: mine.id })
    await w.claude.claimFiles({ task_id: mine.id, paths: ['App/Album/', 'App/Shared/Theme.swift'] })

    const theirs = await w.codex.createTask({ title: 'Theme pass', action: 'edit a file' })
    await w.codex.claimTask({ task_id: theirs.id })
    await rejects(() => w.codex.claimFiles({ task_id: theirs.id, paths: ['App/Shared/Theme.swift'] }), CODES.PATH_CONFLICT)

    const released = await w.claude.releaseFiles({ task_id: mine.id, paths: ['App/Shared/Theme.swift'] })
    assert.deepEqual(released.files, ['App/Album/'])
    const taken = await w.codex.claimFiles({ task_id: theirs.id, paths: ['App/Shared/Theme.swift'] })
    assert.deepEqual(taken.files, ['App/Shared/Theme.swift'])

    // A path that was never claimed is not silently "released".
    const error = await rejects(() => w.claude.releaseFiles({ task_id: mine.id, paths: ['App/Nowhere.swift'] }), CODES.NOT_FOUND)
    assert.deepEqual(error.details.held, ['App/Album/'])
    // Somebody else's task cannot have its claim released from under it.
    await rejects(() => w.codex.releaseFiles({ task_id: mine.id, paths: ['App/Album/'] }), CODES.NOT_PERMITTED)
  } finally {
    w.cleanup()
  }
})

test('shared infrastructure is requested, not claimed: a feature task is refused, an infra_request task is not', async () => {
  const w = world({ sharedInfra: ['App/DI/', 'App/Network/APIClient.swift', 'backend/prisma/schema.prisma'] })
  try {
    const feature = await w.claude.createTask({ title: 'Feed audit', action: 'edit a file' })
    await w.claude.claimTask({ task_id: feature.id })
    const error = await rejects(() => w.claude.claimFiles({ task_id: feature.id, paths: ['App/Feed/', 'App/DI/Container.swift'] }), CODES.REQUIRES_COORDINATION)
    assert.deepEqual(error.details.hits, [{ path: 'App/DI/Container.swift', under: 'App/DI/' }])
    assert.match(error.message, /infra_request/)
    // Nothing was claimed by the refused call — not even the allowed half.
    assert.deepEqual(w.claude.getTask({ task_id: feature.id }).files, [])
    // Claiming the parent of a listed file is the same thing as claiming the file.
    await rejects(() => w.claude.claimFiles({ task_id: feature.id, paths: ['App/Network/'] }), CODES.REQUIRES_COORDINATION)
    // The feature's own area is fine.
    await w.claude.claimFiles({ task_id: feature.id, paths: ['App/Feed/'] })

    const infra = await w.claude.createTask({ title: 'Register the feed service', action: 'edit a file', spec: { infra_request: true } })
    await w.claude.claimTask({ task_id: infra.id })
    const claimed = await w.claude.claimFiles({ task_id: infra.id, paths: ['App/DI/Container.swift'] })
    assert.deepEqual(claimed.files, ['App/DI/Container.swift'])
  } finally {
    w.cleanup()
  }
})

test('without a shared_infra list every path is an ordinary claim', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Anything', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const claimed = await w.claude.claimFiles({ task_id: task.id, paths: ['App/DI/Container.swift'] })
    assert.deepEqual(claimed.files, ['App/DI/Container.swift'])
    assert.deepEqual(w.claude.projectSettings().shared_infra, [])
  } finally {
    w.cleanup()
  }
})

test('a malformed shared_infra list is a configuration error, not an empty list', async () => {
  const w = world({ sharedInfra: ['/abs/path'] })
  try {
    const task = await w.claude.createTask({ title: 'Anything', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    await rejects(() => w.claude.claimFiles({ task_id: task.id, paths: ['App/x.swift'] }), CODES.CONFIG_INVALID)
  } finally {
    w.cleanup()
  }
})

test('findings made against an older snapshot must be re-read before the task claims anything', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Playback audit', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id, git_base: 'bbbbbbb', audit_base: 'aaaaaaa' })
    const error = await rejects(() => w.claude.claimFiles({ task_id: task.id, paths: ['App/Playback/'] }), CODES.DELTA_REQUIRED)
    assert.deepEqual(error.details, { audit_base: 'aaaaaaa', git_base: 'bbbbbbb' })
    assert.match(error.message, /delta_checked_at/)

    await w.claude.updateTask({ task_id: task.id, patch: { spec: { delta_checked_at: '2026-10-06T12:00:00.000Z' } } })
    const claimed = await w.claude.claimFiles({ task_id: task.id, paths: ['App/Playback/'] })
    assert.deepEqual(claimed.files, ['App/Playback/'])
    assert.equal(claimed.audit_base, 'aaaaaaa')

    // The same snapshot and start commit need no delta.
    const fresh = await w.claude.createTask({ title: 'Fresh', action: 'edit a file' })
    await w.claude.claimTask({ task_id: fresh.id, git_base: 'ccccccc', audit_base: 'ccccccc' })
    await w.claude.claimFiles({ task_id: fresh.id, paths: ['App/Fresh/'] })

    // A timestamp that is not one is refused where it is written.
    await rejects(() => w.claude.updateTask({ task_id: fresh.id, patch: { spec: { delta_checked_at: 'yesterday' } } }), CODES.INVALID_INPUT)
  } finally {
    w.cleanup()
  }
})

test('a working copy is bound to one task, recorded on the task and in worktrees.json, and removable once the task is closed', async () => {
  const w = world({ worktreesDir: 'copies' })
  try {
    assert.equal(w.claude.projectSettings().worktrees_dir, 'copies')
    const task = await w.claude.createTask({ title: 'Album audit', action: 'edit a file', needs_review: false })
    await w.claude.claimTask({ task_id: task.id })
    const copy = join(w.sbx.root, 'copies', `${task.id}-album`)
    const record = await w.claude.registerWorktree({ task_id: task.id, path: copy, branch: `agent/${task.id}-album`, git_base: 'abc1234' })
    assert.equal(record.kind, 'task')
    const bound = w.claude.getTask({ task_id: task.id })
    assert.equal(bound.worktree, copy)
    assert.equal(bound.branch, `agent/${task.id}-album`)
    assert.equal(bound.git_base, 'abc1234')

    const file = join(w.sbx.stateDir, 'worktrees.json')
    assert.ok(existsSync(file))
    const map = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(map.worktrees[copy].task_id, task.id)

    // One copy per task, one task per copy.
    await rejects(() => w.claude.registerWorktree({ task_id: task.id, path: join(w.sbx.root, 'copies', 'other') }), CODES.PATH_CONFLICT)
    const other = await w.codex.createTask({ title: 'Other', action: 'edit a file' })
    await w.codex.claimTask({ task_id: other.id })
    await rejects(() => w.codex.registerWorktree({ task_id: other.id, path: copy }), CODES.PATH_CONFLICT)
    // Only the holder binds a copy to a task.
    await rejects(() => w.codex.registerWorktree({ task_id: task.id, path: join(w.sbx.root, 'copies', 'x') }), CODES.NOT_PERMITTED)

    let listed = w.claude.listWorktrees()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].removable, false, 'a live task keeps its copy')

    await w.claude.completeTask({ task_id: task.id, summary: 'done' })
    listed = w.claude.listWorktrees()
    assert.equal(listed[0].removable, true)
    assert.equal(listed[0].task_status, 'completed')

    const gone = await w.claude.unregisterWorktree({ path: copy })
    assert.equal(gone.task_id, task.id)
    assert.deepEqual(w.claude.listWorktrees(), [])
    assert.equal(w.claude.getTask({ task_id: task.id }).worktree, null)
    await rejects(() => w.claude.unregisterWorktree({ path: copy }), CODES.NOT_FOUND)
  } finally {
    w.cleanup()
  }
})

test('a snapshot is recorded without a task and is never removable by gc', async () => {
  const w = world()
  try {
    const snap = join(w.sbx.root, '.claude', 'worktrees', 'audit-20261006-abc1234')
    const record = await w.claude.registerWorktree({ path: snap, git_base: 'abc1234', kind: 'snapshot' })
    assert.equal(record.kind, 'snapshot')
    const [listed] = w.claude.listWorktrees()
    assert.equal(listed.task_id, null)
    assert.equal(listed.removable, false)
    await rejects(() => w.claude.registerWorktree({ path: join(w.sbx.root, 'x'), kind: 'snapshot', task_id: 'tsk_x' }), CODES.INVALID_INPUT)
    await rejects(() => w.claude.registerWorktree({ path: 'relative/path', kind: 'snapshot' }), CODES.INVALID_INPUT)
  } finally {
    w.cleanup()
  }
})
