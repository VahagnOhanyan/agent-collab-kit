// Where the journal is, for every way a session can be started.
//
// The defect this file exists for: a linked worktree has its own
// `--show-toplevel`, so keying the journal by it splits one project into
// several journals, and a review requested from the main tree is invisible to
// an agent started inside a worktree. The journal is keyed by the COMMON git dir.
// Trusted inputs (projectRoot, configDir) are parameters, never env vars.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { initJournal, resolveRoots } from '../src/paths.mjs'
import { git, gitRepo, initialisedJournal, tempDir, writeFixtureConfig } from './helpers.mjs'

function repoWithWorktree() {
  const base = tempDir('collab-roots-')
  const main = gitRepo(join(base, 'main'))
  mkdirSync(join(main, 'src', 'deep'), { recursive: true })
  const worktree = join(base, 'wt')
  git(main, ['worktree', 'add', '-q', worktree, '-b', 'feature'])
  mkdirSync(join(worktree, 'src'), { recursive: true })
  return { base, main, worktree, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('main tree, a subdirectory and a linked worktree resolve to ONE journal root', () => {
  const r = repoWithWorktree()
  try {
    const fromMain = resolveRoots({ cwd: r.main })
    const fromSub = resolveRoots({ cwd: join(r.main, 'src', 'deep') })
    const fromWorktree = resolveRoots({ cwd: join(r.worktree, 'src') })

    assert.equal(fromMain.journalRoot, r.main)
    assert.equal(fromSub.journalRoot, r.main)
    assert.equal(fromWorktree.journalRoot, r.main, 'a worktree shares the main tree journal')
    for (const roots of [fromMain, fromSub, fromWorktree]) {
      assert.equal(roots.stateDir, join(r.main, '.collab'))
      assert.equal(roots.source, 'git')
      assert.equal(roots.initialized, false)
    }

    // ...but each looks at its OWN working tree.
    assert.equal(fromMain.codeRoot, r.main)
    assert.equal(fromSub.codeRoot, r.main)
    assert.equal(fromWorktree.codeRoot, r.worktree)

    assert.equal(existsSync(join(r.main, '.collab')), false, 'resolving never creates anything')
    assert.equal(existsSync(join(r.worktree, '.collab')), false)
  } finally {
    r.cleanup()
  }
})

test('a review requested from the main tree is visible to an agent started in a worktree', async () => {
  const r = repoWithWorktree()
  const configDir = writeFixtureConfig(join(r.base, 'config'))
  try {
    initJournal({ cwd: r.main })
    const claude = createApi({ agentId: 'claude', cwd: join(r.main, 'src', 'deep'), configDir })
    const codex = createApi({ agentId: 'codex', cwd: join(r.worktree, 'src'), configDir })

    const task = await claude.createTask({ title: 'Reviewed across worktrees', action: 'edit a file' })
    await claude.claimTask({ task_id: task.id })
    const review = await claude.requestReview({ task_id: task.id })
    assert.equal(review.routed_to, 'codex')

    const pending = codex.listReviews({ reviewer: 'codex', pending_only: true })
    assert.equal(pending.length, 1, 'the worktree session sees the review')
    assert.equal(pending[0].id, review.review.id)
    assert.equal(codex.store.paths.root, claude.store.paths.root)

    const statusMain = await claude.status()
    const statusWorktree = await codex.status()
    assert.equal(statusMain.git.worktree, r.main, 'status says which tree it looked at')
    assert.equal(statusWorktree.git.worktree, r.worktree)
    assert.equal(statusWorktree.git.branch, 'feature')
    assert.equal(existsSync(join(r.worktree, '.collab')), false)
  } finally {
    r.cleanup()
  }
})

test('a submodule keeps its journal in its own checkout, not in .git/modules', () => {
  const base = tempDir('collab-roots-sub-')
  try {
    const lib = gitRepo(join(base, 'lib'))
    const app = gitRepo(join(base, 'app'))
    git(app, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib'])
    const roots = resolveRoots({ cwd: join(app, 'vendor', 'lib') })
    assert.equal(roots.journalRoot, join(app, 'vendor', 'lib'))
    assert.equal(resolveRoots({ cwd: app }).journalRoot, app)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('outside git: nothing is resolved without a .collab entry, the nearest one is found from below, and only a real journal counts as initialised', () => {
  const base = tempDir('collab-roots-plain-')
  try {
    const project = join(base, 'notes')
    const nested = join(project, 'a', 'b')
    mkdirSync(nested, { recursive: true })

    const bare = resolveRoots({ cwd: nested })
    assert.equal(bare.journalRoot, null)
    assert.equal(bare.stateDir, null)
    assert.equal(bare.initialized, false)

    mkdirSync(join(project, '.collab'))
    const empty = resolveRoots({ cwd: nested })
    assert.equal(empty.journalRoot, project)
    assert.equal(empty.codeRoot, project)
    assert.equal(empty.source, 'collab-dir')
    assert.equal(empty.initialized, false, 'an empty .collab is not a journal')

    initialisedJournal(join(project, '.collab'))
    assert.equal(resolveRoots({ cwd: nested }).initialized, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the home directory and / are refused, however they were reached', () => {
  const base = tempDir('collab-roots-home-')
  try {
    const home = join(base, 'home')
    mkdirSync(join(home, 'Downloads'), { recursive: true })

    // Not resolved at all: home has no journal, so nothing to refuse yet.
    assert.equal(resolveRoots({ cwd: join(home, 'Downloads'), home }).journalRoot, null)

    mkdirSync(join(home, '.collab'))
    assert.throws(() => resolveRoots({ cwd: join(home, 'Downloads'), home }), (e) => e.code === CODES.ROOT_REFUSED)
    rmSync(join(home, '.collab'), { recursive: true })

    gitRepo(home, { commit: false })
    assert.throws(() => resolveRoots({ cwd: join(home, 'Downloads'), home }), (e) => e.code === CODES.ROOT_REFUSED && /home directory/.test(e.message))

    assert.throws(() => resolveRoots({ cwd: base, projectRoot: '/', home }), (e) => e.code === CODES.ROOT_REFUSED && /filesystem root/.test(e.message))
    assert.throws(() => resolveRoots({ cwd: base, projectRoot: home, home }), (e) => e.code === CODES.ROOT_REFUSED)
    assert.throws(() => resolveRoots({ cwd: base, projectRoot: 'relative/dir', home }), (e) => e.code === CODES.ROOT_REFUSED && /absolute/.test(e.message))

    assert.throws(() => initJournal({ cwd: join(home, 'Downloads'), home }), (e) => e.code === CODES.ROOT_REFUSED)
    assert.equal(existsSync(join(home, '.collab')), false, 'a refused init created nothing')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a projectRoot for another project never borrows the shell's working tree", () => {
  const base = tempDir('collab-roots-param-')
  try {
    const a = gitRepo(join(base, 'a'))
    const b = gitRepo(join(base, 'b'))
    const roots = resolveRoots({ cwd: b, projectRoot: a })
    assert.equal(roots.journalRoot, a)
    assert.equal(roots.codeRoot, a, "project A's checks must not run in project B's tree")
    assert.equal(roots.source, 'parameter')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the facade refuses to open a journal that was never initialised, and says how to start one', () => {
  const base = tempDir('collab-roots-api-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const repo = gitRepo(join(base, 'repo'))
    mkdirSync(join(repo, 'pkg'))
    assert.throws(
      () => createApi({ agentId: 'claude', cwd: join(repo, 'pkg'), configDir }),
      (e) => e.code === CODES.NOT_INITIALIZED && e.message.includes('collab init') && e.details.run_in === repo
    )
    assert.equal(existsSync(join(repo, '.collab')), false)

    // An unknown identity is still a hard configuration error, journal or not.
    assert.throws(() => createApi({ agentId: 'nobody', cwd: repo, configDir }), (e) => e.code === CODES.UNKNOWN_AGENT)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
