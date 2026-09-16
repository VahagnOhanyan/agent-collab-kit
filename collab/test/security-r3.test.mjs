// Reproductions for the phase-2 round-3 findings (Codex security re-review).
// Each test was run against the code before its fix and failed there.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { createApi, legacyJournalLookup } from '../src/api.mjs'
import { initJournal } from '../src/paths.mjs'
import { CODES } from '../src/errors.mjs'
import { fixedClock } from '../src/ids.mjs'
import { resolveApproval } from '../src/domain/approvals.mjs'
import { sweep } from '../src/domain/tasks.mjs'
import { apis, git, gitRepo, initialisedJournal, runCli, sandbox, startServer, tempDir, toolPayload, writeFixtureConfig, writeJson } from './helpers.mjs'

const LAYOUT = ['tmp', 'locks', 'tasks', 'messages', 'reviews', 'decisions', 'approvals', 'runs', 'agents']

// ── 1. entering work checks who is asking ─────────────────────────────────

test('R3-1: update_task cannot start a task held by another agent, or one needing a role the caller lacks', async () => {
  const sbx = sandbox()
  const { claude, codex } = apis(sbx)
  try {
    const held = await claude.createTask({ title: 'Map pins', role: 'ios_engineer', action: 'edit a swift file' })
    await claude.assignTask({ task_id: held.id, to_agent: 'claude' })
    await assert.rejects(codex.updateTask({ task_id: held.id, status: 'in_progress' }), (e) => e.code === CODES.NOT_PERMITTED)
    assert.equal(claude.getTask({ task_id: held.id }).status, 'assigned')
    assert.equal(claude.getTask({ task_id: held.id }).owner, 'claude')

    const unowned = await claude.createTask({ title: 'More pins', role: 'ios_engineer', action: 'edit a swift file' })
    await assert.rejects(
      codex.updateTask({ task_id: unowned.id, status: 'in_progress' }),
      (e) => e.code === CODES.NOT_PERMITTED && /needs role "ios_engineer"/.test(e.message)
    )
    assert.equal(claude.getTask({ task_id: unowned.id }).status, 'created')

    // The owner starting it by status gets exactly what a claim gives.
    const started = await claude.updateTask({ task_id: held.id, status: 'in_progress' })
    assert.equal(started.owner, 'claude')
    assert.equal(started.lease.holder, 'claude')
    assert.ok(Date.parse(started.lease.expires_at) > Date.now(), 'a live lease')
  } finally {
    sbx.cleanup()
  }
})

test('R3-1: a non-owner cannot re-status or release a held task to take it over; field edits stay as they were', async () => {
  const sbx = sandbox()
  const { claude, codex } = apis(sbx)
  try {
    const task = await claude.createTask({ title: 'Mine', action: 'edit a file' })
    await claude.claimTask({ task_id: task.id })

    await assert.rejects(codex.updateTask({ task_id: task.id, status: 'created' }), (e) => e.code === CODES.NOT_PERMITTED)
    await assert.rejects(codex.releaseTask({ task_id: task.id, reason: 'mine now' }), (e) => e.code === CODES.NOT_PERMITTED)
    assert.equal((await codex.claimTask({ task_id: task.id })).claimed, false)
    const after = claude.getTask({ task_id: task.id })
    assert.equal(after.status, 'in_progress')
    assert.equal(after.owner, 'claude')

    const edited = await codex.updateTask({ task_id: task.id, patch: { description: 'a note from codex' } })
    assert.equal(edited.description, 'a note from codex')
  } finally {
    sbx.cleanup()
  }
})

test("R3-1: the owner's grant resuming an owned task gives that owner a lease", async () => {
  const sbx = sandbox()
  const { claude, codex } = apis(sbx)
  try {
    const task = await codex.createTask({ title: 'Buy it', action: 'buy a subscription to the weather API' })
    await codex.assignTask({ task_id: task.id, to_agent: 'codex' })
    const approval = await codex.requestUserApproval({ task_id: task.id, action: task.action, reason: 'forecast data' })
    await resolveApproval(claude.ctx, { approval_id: approval.id, decision: 'granted', channel: 'test' })
    const resumed = codex.getTask({ task_id: task.id })
    assert.equal(resumed.status, 'in_progress')
    assert.equal(resumed.owner, 'codex')
    assert.equal(resumed.lease?.holder, 'codex')
    assert.ok(Date.parse(resumed.lease.expires_at) > Date.now())
  } finally {
    sbx.cleanup()
  }
})

// ── 2. sweep decides on the record as it is under the lock ────────────────

// A ctx whose first transaction is preceded by `between` — the interleaving
// "sweep has read its candidates; somebody writes; sweep takes the lock".
function interleaved(api, between) {
  let done = false
  const store = {
    ...api.store,
    transact: async (fn) => {
      if (!done) {
        done = true
        await between()
      }
      return api.store.transact(fn)
    }
  }
  return { ...api.ctx, store }
}

test('R3-2: a lease renewed after sweep looked is not released', async () => {
  const clock = fixedClock()
  const sbx = sandbox()
  const { claude, codex } = apis(sbx, { clock })
  try {
    const task = await codex.createTask({ title: 'Long job', action: 'edit a file' })
    await codex.claimTask({ task_id: task.id, lease_seconds: 60 })
    clock.advance(120 * 1000)

    const result = await sweep(interleaved(claude, () => codex.claimTask({ task_id: task.id, lease_seconds: 3600 })))
    assert.deepEqual(result.released, [])
    const after = codex.getTask({ task_id: task.id })
    assert.equal(after.status, 'in_progress')
    assert.equal(after.owner, 'codex')
    assert.equal(after.lease_expired, false)
  } finally {
    sbx.cleanup()
  }
})

test('R3-2: a task that moved into review after sweep looked is not reset', async () => {
  const clock = fixedClock()
  const sbx = sandbox()
  const { claude, codex } = apis(sbx, { clock })
  try {
    const task = await claude.createTask({ title: 'Review me', action: 'edit a file' })
    await claude.claimTask({ task_id: task.id, lease_seconds: 60 })
    clock.advance(120 * 1000)

    const result = await sweep(interleaved(codex, () => claude.requestReview({ task_id: task.id })))
    assert.deepEqual(result.released, [])
    assert.equal(claude.getTask({ task_id: task.id }).status, 'review')
  } finally {
    sbx.cleanup()
  }
})

// ── 3. git and runners do not trust the inherited environment ─────────────

test('R3-3: a fake git on PATH and GIT_DIR / GIT_WORK_TREE do not change where the journal is', () => {
  const base = tempDir('collab-r3-git-')
  try {
    const repo = gitRepo(join(base, 'repo'))
    const other = gitRepo(join(base, 'other'))
    const fakeBin = join(base, 'fakebin')
    mkdirSync(fakeBin)
    const marker = join(base, 'FAKE_GIT_RAN')
    writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\n: > '${marker}'\necho '${other}/.git'\necho '${other}'\n`, { mode: 0o755 })

    const viaPath = runCli(['project', '--json'], { cwd: repo, env: { PATH: `${fakeBin}${delimiter}${process.env.PATH}` } })
    assert.equal(viaPath.status, 0, viaPath.stderr)
    assert.equal(JSON.parse(viaPath.stdout).journalRoot, repo)
    assert.equal(existsSync(marker), false, 'the git on PATH never ran')

    const viaGitDir = runCli(['project', '--json'], { cwd: repo, env: { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other } })
    assert.equal(viaGitDir.status, 0, viaGitDir.stderr)
    assert.equal(JSON.parse(viaGitDir.stdout).journalRoot, repo)
    assert.equal(JSON.parse(viaGitDir.stdout).codeRoot, repo)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('R3-3: runners find command[0] only on the fixed PATH and run with a sanitised environment', async () => {
  const sbx = sandbox()
  const fakeBin = join(sbx.base, 'fakebin')
  mkdirSync(fakeBin)
  const marker = join(sbx.base, 'FAKE_LINT_RAN')
  writeFileSync(join(fakeBin, 'collab-fake-lint'), `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 })
  writeFileSync(
    join(sbx.root, 'scripts', 'env.mjs'),
    "process.stdout.write(JSON.stringify({ PATH: process.env.PATH, GIT_DIR: process.env.GIT_DIR ?? null, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null }) + '\\n')"
  )
  const configDir = writeFixtureConfig(join(sbx.base, 'cfg-env'), {
    runners: {
      runners: {
        lint: { summary: 'A bare command name.', cwd: '.', command: ['collab-fake-lint'], timeout_seconds: 10, parse: 'exit_code' },
        env: { summary: 'Prints its environment.', cwd: '.', command: [process.execPath, 'scripts/env.mjs'], timeout_seconds: 30, parse: 'exit_code' }
      }
    }
  })
  const server = startServer({
    cwd: sbx.root,
    options: { ...sbx.options, configDir },
    env: { PATH: `${fakeBin}${delimiter}${process.env.PATH}`, GIT_DIR: '/nowhere/.git', NODE_OPTIONS: '--no-warnings' }
  })
  try {
    await server.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    const lint = await server.request(2, 'tools/call', { name: 'start_run', arguments: { runner: 'lint', wait_seconds: 10 } })
    assert.equal(lint.result.isError, true, JSON.stringify(lint.result))
    assert.equal(toolPayload(lint).code, CODES.RUNNER_REFUSED)
    assert.equal(existsSync(marker), false)

    const env = await server.request(3, 'tools/call', { name: 'start_run', arguments: { runner: 'env', wait_seconds: 30 } })
    assert.equal(env.result.isError, false, JSON.stringify(env.result))
    const seen = JSON.parse(env.result.structuredContent.log_tail.split('\n').find((l) => l.startsWith('{')))
    assert.equal(seen.GIT_DIR, null)
    assert.equal(seen.NODE_OPTIONS, null)
    assert.ok(!seen.PATH.includes(fakeBin), `runner PATH must be the fixed one, got ${seen.PATH}`)
  } finally {
    await server.stop()
    sbx.cleanup()
  }
})

// ── 4. a journal the repository could have forged ─────────────────────────

test('R3-4a: a journal committed to the repository is refused — marker or legacy layout', () => {
  const base = tempDir('collab-r3-tracked-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const repo = gitRepo(join(base, 'repo'))
    initialisedJournal(join(repo, '.collab'))
    git(repo, ['add', '-f', '.collab'])
    git(repo, ['commit', '-q', '-m', 'ship a journal'])
    assert.throws(
      () => createApi({ agentId: 'claude', cwd: repo, configDir }),
      (e) => e.code === CODES.JOURNAL_INVALID && /tracked by git/.test(e.message)
    )
    const init = runCli(['init'], { cwd: repo })
    assert.equal(init.status, 1)
    assert.match(init.stderr, /JOURNAL_INVALID/)
    assert.throws(() => initJournal({ cwd: repo, adopt: true }), (e) => e.code === CODES.JOURNAL_INVALID, 'adoption does not launder a tracked journal')

    const legacy = gitRepo(join(base, 'legacy'))
    for (const dir of LAYOUT) {
      mkdirSync(join(legacy, '.collab', dir), { recursive: true })
      writeFileSync(join(legacy, '.collab', dir, '.gitkeep'), '')
    }
    writeFileSync(join(legacy, '.collab', 'events.jsonl'), '')
    git(legacy, ['add', '-f', '.collab'])
    git(legacy, ['commit', '-q', '-m', 'ship a legacy journal'])
    assert.throws(
      () => createApi({ agentId: 'claude', cwd: legacy, configDir }),
      (e) => e.code === CODES.JOURNAL_INVALID && /tracked by git/.test(e.message)
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('R3-4b: a journal copied to another root is refused until the owner adopts it', () => {
  const base = tempDir('collab-r3-copied-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const a = gitRepo(join(base, 'a'))
    const b = gitRepo(join(base, 'b'))
    assert.equal(runCli(['init'], { cwd: a }).status, 0)
    cpSync(join(a, '.collab'), join(b, '.collab'), { recursive: true })

    assert.throws(
      () => createApi({ agentId: 'claude', cwd: b, configDir }),
      (e) => e.code === CODES.JOURNAL_INVALID && /copied or moved/.test(e.message) && /collab init --adopt/.test(e.message)
    )
    const plain = runCli(['init'], { cwd: b })
    assert.equal(plain.status, 1)
    assert.match(plain.stderr, /copied or moved/)

    const byAgent = runCli(['init', '--adopt'], { cwd: b, env: { COLLAB_AGENT_ID: 'codex' } })
    assert.notEqual(byAgent.status, 0)
    assert.match(byAgent.stderr, /agent/)

    // The owner's adoption (the CLI adds a TTY and a typed-back root, round 5).
    assert.equal(initJournal({ cwd: b, adopt: true }).adopted, true)
    assert.equal(JSON.parse(readFileSync(join(b, '.collab', 'journal.json'), 'utf8')).journal_root, b)
    assert.doesNotThrow(() => createApi({ agentId: 'claude', cwd: b, configDir }))
    assert.doesNotThrow(() => createApi({ agentId: 'claude', cwd: a, configDir }), 'the original is still bound to its root')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('R3-4c: an untracked legacy journal the registry vouches for opens, and doctor recommends binding it with init --adopt', () => {
  const sbx = sandbox({ init: false })
  try {
    for (const dir of LAYOUT) mkdirSync(join(sbx.stateDir, dir), { recursive: true })
    writeFileSync(join(sbx.stateDir, 'events.jsonl'), '')
    writeJson(join(sbx.options.registryDir, 'old', 'project.json'), { id: 'old', roots: [sbx.root], legacy_journal: true })

    const doctor = runCli(['doctor'], { cwd: sbx.root, options: sbx.options })
    assert.equal(doctor.status, 0, doctor.stderr)
    assert.match(doctor.stdout, /collab init --adopt/)

    const adopted = initJournal({ projectRoot: sbx.root, adopt: true, legacyJournalFor: legacyJournalLookup({ registryDir: sbx.options.registryDir }) })
    assert.equal(adopted.adopted, true)
    assert.equal(JSON.parse(readFileSync(join(sbx.stateDir, 'journal.json'), 'utf8')).journal_root, sbx.root)

    const again = runCli(['doctor'], { cwd: sbx.root, options: sbx.options })
    assert.equal(again.status, 0, again.stderr)
    assert.doesNotMatch(again.stdout, /init --adopt/)
  } finally {
    sbx.cleanup()
  }
})
