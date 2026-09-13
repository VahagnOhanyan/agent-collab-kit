// Where things live, and the one rule about it that matters.
//
// The staging directory for atomic writes is INSIDE .collab/ and not os.tmpdir().
// rename(2) is atomic only within one filesystem; on a machine where /tmp is a
// different volume from the repo, a tmpdir-based write fails with EXDEV — and it
// fails on that machine only, which is the worst kind of bug to ship.

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// tools/collab/src -> repo root
export const REPO_ROOT = resolve(HERE, '..', '..', '..')

export const CONFIG_DIR = join(REPO_ROOT, 'tools', 'collab', 'config')

export const COLLECTIONS = Object.freeze([
  'tasks',
  'messages',
  'reviews',
  'decisions',
  'approvals',
  'runs',
  'agents'
])

export function stateRoot(env = process.env) {
  // COLLAB_STATE_DIR exists so a test gets its own state directory, and so a
  // worktree can point at the main tree's state if that is ever wanted.
  return env.COLLAB_STATE_DIR ? resolve(env.COLLAB_STATE_DIR) : join(REPO_ROOT, '.collab')
}

export const layout = (root) => ({
  root,
  tmp: join(root, 'tmp'),
  locks: join(root, 'locks'),
  lockFile: join(root, 'locks', 'store.lock'),
  events: join(root, 'events.jsonl'),
  meta: join(root, 'meta.json'),
  collection: (name) => join(root, name),
  record: (name, id) => join(root, name, `${id}.json`),
  runLog: (id) => join(root, 'runs', `${id}.log`)
})

export function ensureLayout(root) {
  const dirs = [root, join(root, 'tmp'), join(root, 'locks'), ...COLLECTIONS.map((c) => join(root, c))]
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  return layout(root)
}
