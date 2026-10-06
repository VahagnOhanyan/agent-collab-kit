// A task's working copy, on record.
//
// One writing agent per tree is the rule; a git worktree per writing task is
// how ten agents keep it. The journal already serves every worktree of one
// repository (paths.mjs: the journal root is the parent of the COMMON git dir),
// so a claim made from any copy is seen from every other. What was missing is
// the binding: which copy belongs to which task. That is this file —
// `<state>/worktrees.json`, keyed by the copy's real path — and the `worktree`
// field on the task. The claim-guard hook reads the map and then the task's
// record straight from disk, so an edit inside a bound copy is checked against
// that task's claim without starting a process.
//
// Git itself (worktree add / remove, branches) is the CLI's business
// (`collab worktree …`): this module records, it does not run git. A record
// for a copy that no longer exists is harmless — nothing edits there — and
// `gc` drops it.

import { join } from 'node:path'
import { CODES, CollabError } from '../errors.mjs'
import { readJson, writeJsonAtomic } from '../jsonio.mjs'
import { TERMINAL } from '../transitions.mjs'
import { assertOwnerOrContributor } from './gate.mjs'

export const WORKTREES_FILE = 'worktrees.json'
export const WORKTREE_KINDS = Object.freeze(['task', 'snapshot'])

const toPosix = (p) => String(p).replace(/\\/g, '/')

function mapFile(ctx) {
  return join(ctx.store.paths.root, WORKTREES_FILE)
}

export function readWorktrees(ctx) {
  const raw = readJson(mapFile(ctx), null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.worktrees !== 'object' || raw.worktrees === null) {
    return { version: 1, worktrees: {} }
  }
  return { version: 1, worktrees: { ...raw.worktrees } }
}

function writeWorktrees(ctx, map) {
  writeJsonAtomic(mapFile(ctx), { version: 1, worktrees: map.worktrees }, { tmpDir: ctx.store.paths.tmp })
}

function absolutePath(value, what) {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    throw new CollabError(CODES.INVALID_INPUT, `${what} must be a non-empty path`, { field: what })
  }
  const posix = toPosix(value)
  if (!(posix.startsWith('/') || /^[A-Za-z]:\//.test(posix))) {
    throw new CollabError(CODES.INVALID_INPUT, `${what} must be an absolute path, got ${JSON.stringify(value)}`, { field: what })
  }
  return posix.replace(/\/+$/, '')
}

// Bind a copy to a task (kind 'task'), or record a read-only snapshot for
// audits (kind 'snapshot', no task). The task's own record gets `worktree`,
// `branch` and `git_base`, so `collab task <id>` shows where its work lives.
export function registerWorktree(ctx, { path, task_id = null, branch = null, git_base = null, kind = 'task' }) {
  const copy = absolutePath(path, 'path')
  if (!WORKTREE_KINDS.includes(kind)) {
    throw new CollabError(CODES.INVALID_INPUT, `kind must be one of ${WORKTREE_KINDS.join(', ')}`, { field: 'kind' })
  }
  if (kind === 'task' && !task_id) throw new CollabError(CODES.INVALID_INPUT, 'a task worktree needs task_id', { field: 'task_id' })
  if (kind === 'snapshot' && task_id) throw new CollabError(CODES.INVALID_INPUT, 'a snapshot is not bound to a task', { field: 'task_id' })
  return ctx.store.transact(async (tx) => {
    const map = readWorktrees(ctx)
    const existing = map.worktrees[copy]
    if (existing && existing.task_id && existing.task_id !== task_id) {
      throw new CollabError(CODES.PATH_CONFLICT, `${copy} is already the working copy of ${existing.task_id}`, { path: copy, task_id: existing.task_id })
    }
    let task = null
    if (task_id) {
      task = tx.get('tasks', task_id)
      if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
      if (TERMINAL.has(task.status)) {
        throw new CollabError(CODES.ILLEGAL_TRANSITION, `task ${task_id} is ${task.status}; a closed task gets no working copy`, { id: task_id, status: task.status })
      }
      assertOwnerOrContributor(task, ctx.agentId, 'bind a working copy to')
      const other = Object.entries(map.worktrees).find(([p, e]) => e.task_id === task_id && p !== copy)
      if (other) {
        throw new CollabError(CODES.PATH_CONFLICT, `task ${task_id} already has a working copy at ${other[0]}; remove it first (collab worktree gc)`, {
          id: task_id,
          path: other[0]
        })
      }
      task = tx.put('tasks', { ...task, worktree: copy, branch: branch || task.branch, git_base: git_base || task.git_base })
    }
    map.worktrees[copy] = {
      kind,
      task_id: task_id || null,
      branch: branch || null,
      git_base: git_base || null,
      created_by: ctx.agentId,
      created_at: tx.iso()
    }
    writeWorktrees(ctx, map)
    tx.emit('worktree.registered', task ? { collection: 'tasks', id: task.id } : null, { path: copy, kind, branch, git_base })
    return { path: copy, ...map.worktrees[copy] }
  })
}

export function unregisterWorktree(ctx, { path }) {
  const copy = absolutePath(path, 'path')
  return ctx.store.transact(async (tx) => {
    const map = readWorktrees(ctx)
    const entry = map.worktrees[copy]
    if (!entry) throw new CollabError(CODES.NOT_FOUND, `${copy} is not a registered working copy`, { path: copy })
    let task = entry.task_id ? tx.get('tasks', entry.task_id) : null
    if (task && task.worktree === copy) task = tx.put('tasks', { ...task, worktree: null })
    delete map.worktrees[copy]
    writeWorktrees(ctx, map)
    tx.emit('worktree.unregistered', task ? { collection: 'tasks', id: task.id } : null, { path: copy, kind: entry.kind })
    return { path: copy, ...entry }
  })
}

// Every record, with what the journal knows about its task now. `removable`
// is the gc rule: a snapshot is never removed here (the owner decides when an
// audit wave is over); a task copy is removable once its task is closed or
// gone. A live task's copy is never removable, whatever its lease says — a
// lapsed lease means "claimable again", not "the work is gone".
export function listWorktrees(ctx) {
  const map = readWorktrees(ctx)
  return Object.entries(map.worktrees)
    .map(([path, entry]) => {
      const task = entry.task_id ? ctx.store.get('tasks', entry.task_id) : null
      const closed = entry.kind === 'task' && (!task || TERMINAL.has(task.status))
      return {
        path,
        ...entry,
        task_status: task ? task.status : entry.task_id ? 'missing' : null,
        task_owner: task ? task.owner : null,
        removable: closed
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}
