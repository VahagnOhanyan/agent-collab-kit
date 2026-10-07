// The parallel-work settings of the project the journal belongs to, read from
// its TRUSTED registry entry (<registry>/<id>/project.json) — the same file the
// hooks read plan_gate, post_edit and githooks_dir from. The server learns which
// registry entry it runs under from config.meta.source (registry.mjs loadConfig);
// a journal with no registry project has no settings and every key is empty.
//
//   shared_infra   path prefixes a feature task may not claim: the DI container,
//                  the network client, the session, the schema, the route table,
//                  the cross-side registries. A claim on one answers
//                  REQUIRES_COORDINATION unless the task is an infra_request.
//   worktrees_dir  where `collab worktree add` puts a task's working copy,
//                  relative to the code root. Default `.claude/worktrees`.
//   git_config     [[key, value], …] the session-start hook sets in every clone
//                  (a merge driver, for instance). Not read here; validated here
//                  so one place says what the file may contain.
//   worktree_clone ignored directories `collab worktree add` clones from the code
//                  root into a new copy (dependency trees such as
//                  `backend/node_modules`), copy-on-write — see worktree-clone.mjs.
//
// A malformed value is a configuration problem and is reported as one rather
// than silently read as "nothing configured": an owner who wrote the list wants
// it to hold.

import { join } from 'node:path'
import { CODES, CollabError } from '../errors.mjs'
import { readJson } from '../jsonio.mjs'
import { findProject } from '../projects.mjs'

export const DEFAULT_WORKTREES_DIR = '.claude/worktrees'

const toPosix = (p) => String(p).replace(/\\/g, '/')

function relativeList(value, key, file) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) {
    throw new CollabError(CODES.CONFIG_INVALID, `${file}: "${key}" must be a list of non-empty strings`, { key })
  }
  const list = value.map(toPosix)
  const bad = list.find((p) => p.startsWith('/') || /^[A-Za-z]:\//.test(p) || p.split('/').includes('..'))
  if (bad) {
    throw new CollabError(CODES.CONFIG_INVALID, `${file}: "${key}" holds ${JSON.stringify(bad)} — paths are relative to the project root, without ".."`, { key, path: bad })
  }
  return [...new Set(list)]
}

function projectDir(ctx) {
  const source = ctx.config?.meta?.source
  if (source?.kind === 'project' && source.dir) return source.dir
  // A config loaded from an explicit directory (tests, `collab --config`) still
  // belongs to a registry project if the journal root is one of its roots.
  if (!ctx.roots?.journalRoot || !ctx.registryDir) return null
  try {
    const project = findProject(ctx.roots.journalRoot, { registry: ctx.registryDir, ...(ctx.home ? { home: ctx.home } : {}) })
    return project ? project.dir : null
  } catch {
    return null
  }
}

export function projectSettings(ctx) {
  const dir = projectDir(ctx)
  if (!dir) return { shared_infra: [], worktrees_dir: DEFAULT_WORKTREES_DIR, git_config: [], worktree_clone: [], file: null }
  const file = join(dir, 'project.json')
  const raw = readJson(file, null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { shared_infra: [], worktrees_dir: DEFAULT_WORKTREES_DIR, git_config: [], worktree_clone: [], file }
  }
  const worktreeClone = relativeList(raw.worktree_clone, 'worktree_clone', file).map((p) => p.replace(/\/+$/, ''))
  const sharedInfra = relativeList(raw.shared_infra, 'shared_infra', file)
  let worktreesDir = DEFAULT_WORKTREES_DIR
  if (raw.worktrees_dir !== undefined && raw.worktrees_dir !== null) {
    const [dir] = relativeList([raw.worktrees_dir], 'worktrees_dir', file)
    worktreesDir = dir.replace(/\/+$/, '')
  }
  let gitConfig = []
  if (raw.git_config !== undefined && raw.git_config !== null) {
    if (
      !Array.isArray(raw.git_config) ||
      raw.git_config.some((pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((x) => typeof x !== 'string' || x === ''))
    ) {
      throw new CollabError(CODES.CONFIG_INVALID, `${file}: "git_config" must be a list of [key, value] string pairs`, { key: 'git_config' })
    }
    gitConfig = raw.git_config.map(([k, v]) => [k, v])
  }
  return { shared_infra: sharedInfra, worktrees_dir: worktreesDir, git_config: gitConfig, worktree_clone: worktreeClone, file }
}

// Which of `paths` fall under the shared-infrastructure list. Prefix-aware the
// same way claims are: listing `App/DI/` covers every file in it, and listing a
// file covers that file. Returns [{ path, under }] for the caller's message.
export function sharedInfraHits(paths, sharedInfra) {
  const hits = []
  for (const p of paths) {
    const path = toPosix(p)
    for (const infra of sharedInfra) {
      const dir = infra.endsWith('/') ? infra : `${infra}/`
      if (path === infra || path.startsWith(dir) || infra.startsWith(path.endsWith('/') ? path : `${path}/`)) {
        hits.push({ path, under: infra })
        break
      }
    }
  }
  return hits
}
