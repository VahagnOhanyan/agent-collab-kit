// Phase-2 round 5 (final Codex re-review). Each test was run against the code
// before its fix and failed there.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApi, describeProject } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { fixedClock } from '../src/ids.mjs'
import * as paths from '../src/paths.mjs'
import { readProjectEntry } from '../src/projects.mjs'
import { KIT_REGISTRY, apis, git, gitRepo, initialisedJournal, runCli, sandbox, tempDir, writeFixtureConfig, writeJson } from './helpers.mjs'

const LAYOUT = ['tmp', 'locks', 'tasks', 'messages', 'reviews', 'decisions', 'approvals', 'runs', 'agents']

function trackedJournalRepo(base) {
  const repo = gitRepo(join(base, 'repo'))
  initialisedJournal(join(repo, '.collab'))
  git(repo, ['add', '-f', '.collab'])
  git(repo, ['commit', '-q', '-m', 'ship a journal'])
  return repo
}

function legacyLayout(stateDir) {
  for (const dir of LAYOUT) mkdirSync(join(stateDir, dir), { recursive: true })
  writeFileSync(join(stateDir, 'events.jsonl'), '')
  return stateDir
}

// ── 1. the tracked-journal check fails closed ─────────────────────────────

test('R5-1: an invalid DEVELOPER_DIR does not turn a tracked journal into an accepted one', () => {
  const base = tempDir('collab-r5-devdir-')
  try {
    const repo = trackedJournalRepo(base)
    const env = { DEVELOPER_DIR: '/nonexistent-developer-dir', SDKROOT: '/nonexistent-sdk' }
    const status = runCli(['status'], { cwd: repo, env })
    assert.equal(status.status, 1, status.stdout)
    assert.match(status.stderr, /JOURNAL_INVALID/)
    const described = JSON.parse(runCli(['project', '--json'], { cwd: repo, env }).stdout)
    assert.equal(described.journalProblem?.code, 'JOURNAL_INVALID')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('R5-1: git is chosen by a working --version probe, and Apple toolchain variables are stripped', () => {
  const base = tempDir('collab-r5-probe-')
  try {
    const failing = join(base, 'failing-git')
    writeFileSync(failing, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const liar = join(base, 'liar-git')
    writeFileSync(liar, '#!/bin/sh\necho hello\n', { mode: 0o755 })
    const real = paths.gitBinary()
    assert.ok(real, 'this machine has a working git')
    assert.equal(paths.selectGit([join(base, 'missing-git'), failing, liar, real]), real)
    assert.equal(paths.selectGit([failing, liar]), null)

    const env = paths.sanitisedEnv({
      HOME: '/home/owner',
      LANG: 'en_US.UTF-8',
      DEVELOPER_DIR: '/x',
      SDKROOT: '/x',
      TOOLCHAINS: 'x',
      xcrun_verbose: '1',
      XCRUN_LOG: '1',
      XCODE_VERSION_ACTUAL: '1',
      GIT_DIR: '/x',
      NODE_OPTIONS: '--x'
    })
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('R5-1: a git error that is not "not a git repository" makes a journal invalid, never accepted', () => {
  const base = tempDir('collab-r5-giterror-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const repo = trackedJournalRepo(base)
    writeFileSync(join(repo, '.git', 'config'), '[core\n  this is not a config file\n', { flag: 'a' })
    assert.throws(() => createApi({ agentId: 'claude', cwd: repo, configDir }), (e) => e.code === CODES.JOURNAL_INVALID)
    assert.equal(describeProject({ cwd: repo }).journalProblem?.code, 'JOURNAL_INVALID')

    // A definitive "not a git repository" is still just that.
    const plain = join(base, 'plain')
    mkdirSync(plain)
    initialisedJournal(join(plain, '.collab'))
    assert.doesNotThrow(() => createApi({ agentId: 'claude', cwd: plain, configDir }))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ── 2. assign_task cannot take a task away ────────────────────────────────

test('R5-2: reassigning a held task is refused unless the caller holds it or the lease has lapsed', async () => {
  const clock = fixedClock()
  const sbx = sandbox()
  const { claude, codex } = apis(sbx, { clock })
  try {
    const assigned = await claude.createTask({ title: 'Assigned to claude', action: 'edit a file' })
    await claude.assignTask({ task_id: assigned.id, to_agent: 'claude' })
    await assert.rejects(codex.assignTask({ task_id: assigned.id, to_agent: 'codex' }), (e) => e.code === CODES.NOT_PERMITTED)
    assert.equal(claude.getTask({ task_id: assigned.id }).owner, 'claude')

    const reworked = await claude.createTask({ title: 'Changes requested', action: 'edit a file' })
    await claude.claimTask({ task_id: reworked.id })
    const review = await claude.requestReview({ task_id: reworked.id })
    await codex.submitReview({ review_id: review.review.id, verdict: 'changes_requested', summary: 'one thing', findings: [{ note: 'rename it' }] })
    await assert.rejects(codex.assignTask({ task_id: reworked.id, to_agent: 'codex' }), (e) => e.code === CODES.NOT_PERMITTED)
    assert.equal(claude.getTask({ task_id: reworked.id }).owner, 'claude')

    // The holder hands its own task over.
    const handed = await claude.assignTask({ task_id: assigned.id, to_agent: 'codex' })
    assert.equal(handed.owner, 'codex')
    assert.equal(handed.lease?.holder, 'codex', 'an assignment carries a lease, so an absent assignee does not hold it forever')

    // Once that lease lapses, anybody may reassign it.
    clock.advance(2 * 3600 * 1000)
    const reclaimed = await claude.assignTask({ task_id: assigned.id, to_agent: 'claude' })
    assert.equal(reclaimed.owner, 'claude')

    // An unowned task stays open to coordination.
    const pool = await codex.createTask({ title: 'Nobody yet', action: 'edit a file' })
    assert.equal((await claude.assignTask({ task_id: pool.id, to_agent: 'codex' })).owner, 'codex')
  } finally {
    sbx.cleanup()
  }
})

// ── 3. a markerless legacy journal needs the registry's say-so ────────────

test('R5-3: a markerless legacy layout is accepted only for a registry project that declares legacy_journal', () => {
  const base = tempDir('collab-r5-legacy-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const unflagged = gitRepo(join(base, 'unflagged'))
    legacyLayout(join(unflagged, '.collab'))
    const emptyRegistry = join(base, 'empty-registry')
    assert.throws(
      () => createApi({ agentId: 'claude', cwd: unflagged, configDir, registryDir: emptyRegistry }),
      (e) => e.code === CODES.JOURNAL_INVALID && /collab init --adopt/.test(e.message)
    )

    const flagged = gitRepo(join(base, 'flagged'))
    legacyLayout(join(flagged, '.collab'))
    const registry = join(base, 'registry')
    writeJson(join(registry, 'old', 'project.json'), { id: 'old', roots: [flagged], legacy_journal: true })
    const api = createApi({ agentId: 'claude', cwd: flagged, configDir, registryDir: registry })
    assert.equal(api.doctor().journal_kind, 'legacy')

    // Only a real boolean counts, and Tripix's entry carries the flag.
    writeJson(join(registry, 'loose', 'project.json'), { id: 'loose', roots: [join(base, 'loose')], legacy_journal: 'yes' })
    assert.ok(readProjectEntry(join(registry, 'loose'), 'loose').problems.some((p) => /legacy_journal/.test(p)))
    assert.equal(JSON.parse(readFileSync(join(KIT_REGISTRY, 'tripix', 'project.json'), 'utf8')).legacy_journal, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ── 4. adopting a journal is the owner's, at a terminal ───────────────────

test('R5-4: collab init --adopt refuses without an interactive terminal, and changes nothing', () => {
  const base = tempDir('collab-r5-adopt-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const a = gitRepo(join(base, 'a'))
    const b = gitRepo(join(base, 'b'))
    assert.equal(runCli(['init'], { cwd: a }).status, 0)
    cpSync(join(a, '.collab'), join(b, '.collab'), { recursive: true })
    const markerBefore = readFileSync(join(b, '.collab', 'journal.json'), 'utf8')

    const refused = runCli(['init', '--adopt'], { cwd: b })
    assert.equal(refused.status, 3, refused.stdout)
    assert.match(refused.stderr, /interactive terminal/)
    assert.equal(readFileSync(join(b, '.collab', 'journal.json'), 'utf8'), markerBefore)
    assert.throws(() => createApi({ agentId: 'claude', cwd: b, configDir }), (e) => e.code === CODES.JOURNAL_INVALID)

    const byAgent = runCli(['init', '--adopt'], { cwd: b, env: { COLLAB_AGENT_ID: 'codex' } })
    assert.equal(byAgent.status, 3)
    assert.match(byAgent.stderr, /agent/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
