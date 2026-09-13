// `collab init`, run as a real process: the only thing that creates a journal.
//
// The ignore entry goes to the git COMMON dir's info/exclude: it applies to
// every worktree and changes no tracked file, so initialising a project leaves
// `git status` exactly as it was.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { git, gitRepo, runCli, tempDir } from './helpers.mjs'

const countLines = (text, line) => text.split('\n').filter((l) => l.trim() === line).length
const exclude = (repo) => join(repo, '.git', 'info', 'exclude')
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')

test('H: init in a git subdirectory creates the journal at the root and ignores it via info/exclude, idempotently', () => {
  const base = tempDir('collab-init-')
  try {
    const repo = gitRepo(join(base, 'repo'))
    mkdirSync(join(repo, 'src'))
    const statusBefore = git(repo, ['status', '--porcelain', '--untracked-files=all'])

    const first = runCli(['init'], { cwd: join(repo, 'src') })
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /initialized/)
    assert.ok(statSync(join(repo, '.collab', 'tasks')).isDirectory())
    assert.ok(existsSync(join(repo, '.collab', 'journal.json')), 'init writes the marker')
    assert.equal(existsSync(join(repo, 'src', '.collab')), false)
    assert.equal(existsSync(join(repo, '.gitignore')), false, 'no tracked file is created or changed')
    const excluded = read(exclude(repo))
    assert.equal(countLines(excluded, '.collab/'), 1)
    assert.equal(git(repo, ['status', '--porcelain', '--untracked-files=all']), statusBefore, 'git status is exactly as before')

    const second = runCli(['init'], { cwd: repo })
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /already initialized/)
    assert.match(second.stdout, /already ignored/)
    assert.equal(read(exclude(repo)), excluded, 'info/exclude is not touched twice')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('H: init leaves an existing .gitignore byte-for-byte alone, and writes nothing when git already ignores .collab', () => {
  const base = tempDir('collab-init-ignore-')
  try {
    const plain = gitRepo(join(base, 'plain'), { commit: false })
    writeFileSync(join(plain, '.gitignore'), 'node_modules')
    assert.equal(runCli(['init'], { cwd: plain }).status, 0)
    assert.equal(readFileSync(join(plain, '.gitignore'), 'utf8'), 'node_modules')
    assert.equal(countLines(read(exclude(plain)), '.collab/'), 1)

    const covered = gitRepo(join(base, 'covered'), { commit: false })
    writeFileSync(join(covered, '.gitignore'), '.collab/\n')
    const excludeBefore = read(exclude(covered))
    const result = runCli(['init'], { cwd: covered })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /already ignored/)
    assert.equal(readFileSync(join(covered, '.gitignore'), 'utf8'), '.collab/\n')
    assert.equal(read(exclude(covered)), excludeBefore)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('H: init from a linked worktree initialises the main tree journal and excludes it in the common dir', () => {
  const base = tempDir('collab-init-wt-')
  try {
    const main = gitRepo(join(base, 'main'))
    const worktree = join(base, 'wt')
    git(main, ['worktree', 'add', '-q', worktree, '-b', 'side'])

    const result = runCli(['init'], { cwd: worktree })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(join(main, '.collab', 'journal.json')))
    assert.equal(existsSync(join(worktree, '.collab')), false)
    assert.equal(existsSync(join(main, '.gitignore')), false)
    assert.equal(countLines(read(exclude(main)), '.collab/'), 1)
    assert.equal(git(main, ['status', '--porcelain', '--untracked-files=all']), '')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('init outside git just creates the directory, and commands from below then find it', () => {
  const base = tempDir('collab-init-plain-')
  try {
    const project = join(base, 'notes')
    mkdirSync(join(project, 'drafts'), { recursive: true })

    const result = runCli(['init'], { cwd: project })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /not a git repository/)
    assert.ok(existsSync(join(project, '.collab', 'journal.json')))
    assert.equal(existsSync(join(project, '.gitignore')), false)

    const status = runCli(['status'], { cwd: join(project, 'drafts') })
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /not a git working tree/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('init refuses the home directory and /, and creates nothing', () => {
  const base = tempDir('collab-init-refuse-')
  try {
    const home = join(base, 'home')
    mkdirSync(home)
    const inHome = runCli(['init'], { cwd: home, env: { HOME: home } })
    assert.equal(inHome.status, 1)
    assert.match(inHome.stderr, /ROOT_REFUSED/)
    assert.match(inHome.stderr, /home directory/)
    assert.equal(existsSync(join(home, '.collab')), false)

    const atRoot = runCli(['init'], { cwd: '/', env: { HOME: home } })
    assert.equal(atRoot.status, 1)
    assert.match(atRoot.stderr, /ROOT_REFUSED/)
    assert.match(atRoot.stderr, /filesystem root/)

    const viaOption = runCli(['init'], { cwd: base, env: { HOME: home }, options: { projectRoot: '/' } })
    assert.equal(viaOption.status, 1)
    assert.match(viaOption.stderr, /ROOT_REFUSED/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
