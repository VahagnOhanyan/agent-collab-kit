// Reproductions for the phase-2 security and correctness findings (A–F).
// Each test was written against the code BEFORE its fix and failed there; the
// report lists which ones did and which could not be reproduced.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
// A directory symlink needs no elevation on POSIX; on Windows the equivalent
// that doesn't need admin/Developer Mode is a junction, which every call site
// below can use unchanged since all of their targets are already absolute
// (tempDir()/sbx.base always return an absolute realpath, and junctions
// require an absolute target). There is no such escape hatch for a *file*
// symlink (see the one call site below that still calls symlinkSync directly).
const linkDir = (target, dest) => symlinkSync(target, dest, IS_WINDOWS ? 'junction' : undefined)

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { resolveApproval } from '../src/domain/approvals.mjs'
import {
  CLI,
  apis,
  cleanEnv,
  gitRepo,
  removeTree,
  runCli,
  sandbox,
  startServer,
  tempDir,
  toolPayload,
  writeFixtureConfig,
  writeJson
} from './helpers.mjs'

const LAYOUT = ['tmp', 'locks', 'tasks', 'messages', 'reviews', 'decisions', 'approvals', 'runs', 'agents']

const markerRunner = (marker) => ({
  summary: 'Writes a marker file wherever it runs.',
  cwd: '.',
  command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`],
  timeout_seconds: 10,
  parse: 'exit_code'
})

// ── A. environment variables are not trusted inputs ───────────────────────

test('A: COLLAB_CONFIG_DIR / COLLAB_REGISTRY_DIR / COLLAB_PROJECT_ROOT in the environment are ignored, and doctor says so', () => {
  const base = tempDir('collab-sec-env-')
  try {
    const project = join(base, 'project')
    const other = join(base, 'other')
    mkdirSync(project)
    mkdirSync(other)
    assert.equal(runCli(['init'], { cwd: project }).status, 0)
    assert.equal(runCli(['init'], { cwd: other }).status, 0)

    const marker = join(base, 'PWNED')
    const config = writeFixtureConfig(join(base, 'repo-config'), { runners: { runners: { evil: markerRunner(marker) } } })
    const registry = join(base, 'repo-registry')
    writeJson(join(registry, 'evil', 'project.json'), { id: 'evil', roots: [project] })
    writeJson(join(registry, 'evil', 'collab', 'runners.json'), { runners: { evil: markerRunner(marker) } })

    for (const env of [{ COLLAB_CONFIG_DIR: config }, { COLLAB_REGISTRY_DIR: registry }, { COLLAB_PROJECT_ROOT: other }]) {
      const name = Object.keys(env)[0]
      const doctor = runCli(['doctor'], { cwd: project, env })
      assert.equal(doctor.status, 0, `${name}: ${doctor.stderr}`)
      assert.doesNotMatch(doctor.stdout, /^\s+evil\s/m, `${name} must not be able to supply runners`)
      assert.ok(doctor.stdout.includes(`journal      ${project}`), `${name} must not move the journal:\n${doctor.stdout}`)
      assert.match(doctor.stdout, new RegExp(`ignored env\\s+.*${name}`), `${name} must be reported as ignored`)
    }
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('A: a server started with COLLAB_CONFIG_DIR set still lists and runs only trusted runners', async () => {
  const base = tempDir('collab-sec-env-mcp-')
  const project = join(base, 'project')
  mkdirSync(project)
  assert.equal(runCli(['init'], { cwd: project }).status, 0)
  const marker = join(base, 'PWNED')
  const config = writeFixtureConfig(join(base, 'repo-config'), { runners: { runners: { evil: markerRunner(marker) } } })
  const server = startServer({ cwd: project, env: { COLLAB_CONFIG_DIR: config } })
  try {
    await server.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    const listed = await server.request(2, 'tools/call', { name: 'list_runners', arguments: {} })
    assert.deepEqual(toolPayload(listed), [])
    const started = await server.request(3, 'tools/call', { name: 'start_run', arguments: { runner: 'evil', wait_seconds: 5 } })
    assert.equal(started.result.isError, true)
    assert.equal(toolPayload(started).code, CODES.RUNNER_REFUSED)
    assert.equal(existsSync(marker), false)
  } finally {
    await server.stop()
    rmSync(base, { recursive: true, force: true })
  }
})

// ── B. every way into in_progress passes the approval gate ────────────────

test('B: update_task cannot move a task that needs the owner into in_progress', async () => {
  const sbx = sandbox()
  const { claude, codex } = apis(sbx)
  try {
    const money = await codex.createTask({ title: 'Buy the data plan', action: 'buy a subscription to the flight data API' })
    await assert.rejects(codex.updateTask({ task_id: money.id, status: 'in_progress' }), (e) => e.code === CODES.APPROVAL_REQUIRED)
    assert.equal(codex.getTask({ task_id: money.id }).status, 'created')

    await codex.updateTask({ task_id: money.id, status: 'blocked', reason: 'parked' })
    await assert.rejects(codex.updateTask({ task_id: money.id, status: 'in_progress' }), (e) => e.code === CODES.APPROVAL_REQUIRED)

    const prod = await claude.createTask({ title: 'Ship it', action: 'deploy the backend' })
    await claude.assignTask({ task_id: prod.id, to_agent: 'claude' })
    await assert.rejects(claude.updateTask({ task_id: prod.id, status: 'in_progress' }), (e) => e.code === CODES.APPROVAL_REQUIRED)
    assert.equal(claude.getTask({ task_id: prod.id }).status, 'assigned')

    // Ordinary work still moves freely.
    const safe = await claude.createTask({ title: 'Tidy', action: 'edit a file' })
    assert.equal((await claude.updateTask({ task_id: safe.id, status: 'in_progress' })).status, 'in_progress')
  } finally {
    sbx.cleanup()
  }
})

// ── C. a grant is single-use ──────────────────────────────────────────────

test('C: a grant is consumed by the move it authorises; release and reclaim with the same grant is refused', async () => {
  const sbx = sandbox()
  const { claude, codex } = apis(sbx)
  try {
    const task = await codex.createTask({ title: 'Buy it', action: 'buy a subscription to the mapping API' })
    const approval = await codex.requestUserApproval({ task_id: task.id, action: task.action, reason: 'needed for tiles' })
    await resolveApproval(claude.ctx, { approval_id: approval.id, decision: 'granted', channel: 'test' })

    const first = await codex.claimTask({ task_id: task.id })
    assert.equal(first.claimed, true)
    const used = claude.listApprovals({ pending_only: false }).find((a) => a.id === approval.id)
    assert.ok(used.consumed_at, 'the claim consumed the grant')
    assert.equal(used.consumed_by, 'codex')
    assert.ok(claude.events({ limit: 50 }).some((e) => e.type === 'approval.consumed' && e.subject.id === approval.id))

    await codex.releaseTask({ task_id: task.id, reason: 'interrupted' })
    await assert.rejects(codex.claimTask({ task_id: task.id }), (e) => e.code === CODES.APPROVAL_INVALID && /already used/.test(e.message))
    await assert.rejects(codex.updateTask({ task_id: task.id, status: 'in_progress' }), (e) => e.code === CODES.APPROVAL_INVALID)
  } finally {
    sbx.cleanup()
  }
})

test('C: the owner granting a task that already has an owner starts it and consumes the grant in the same write', async () => {
  const sbx = sandbox()
  const { claude, codex } = apis(sbx)
  try {
    const task = await codex.createTask({ title: 'Buy it', action: 'buy a subscription to the weather API' })
    await codex.assignTask({ task_id: task.id, to_agent: 'codex' })
    const approval = await codex.requestUserApproval({ task_id: task.id, action: task.action, reason: 'forecast data' })
    await resolveApproval(claude.ctx, { approval_id: approval.id, decision: 'granted', channel: 'test' })

    assert.equal(codex.getTask({ task_id: task.id }).status, 'in_progress')
    assert.ok(claude.listApprovals({ pending_only: false }).find((a) => a.id === approval.id).consumed_at)

    await codex.updateTask({ task_id: task.id, status: 'created' })
    await assert.rejects(codex.updateTask({ task_id: task.id, status: 'in_progress' }), (e) => e.code === CODES.APPROVAL_INVALID)
  } finally {
    sbx.cleanup()
  }
})

test('C: a grant for a different action text does not start this task', async () => {
  const sbx = sandbox()
  const { claude, codex } = apis(sbx)
  try {
    const task = await codex.createTask({ title: 'Buy one thing', action: 'buy a subscription to the flight data API' })
    const approval = await codex.requestUserApproval({ task_id: task.id, action: 'buy a subscription to the weather API', reason: 'x' })
    await resolveApproval(claude.ctx, { approval_id: approval.id, decision: 'granted', channel: 'test' })
    await assert.rejects(codex.claimTask({ task_id: task.id }), (e) => e.code === CODES.APPROVAL_INVALID && /different action/.test(e.message))
    await assert.rejects(codex.updateTask({ task_id: task.id, status: 'in_progress' }), (e) => e.code === CODES.APPROVAL_INVALID)
  } finally {
    sbx.cleanup()
  }
})

// ── D. what counts as an initialised journal ──────────────────────────────

test('D: a symlinked .collab is not a journal — NOT_INITIALIZED, and its target is left untouched', () => {
  const base = tempDir('collab-sec-link-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const target = join(base, 'elsewhere')
    mkdirSync(target)
    const repo = gitRepo(join(base, 'repo'))
    linkDir(target, join(repo, '.collab'))
    assert.throws(() => createApi({ agentId: 'claude', cwd: repo, configDir }), (e) => e.code === CODES.NOT_INITIALIZED)
    assert.deepEqual(readdirSync(target), [])

    const plain = join(base, 'plain')
    mkdirSync(join(plain, 'sub'), { recursive: true })
    linkDir(target, join(plain, '.collab'))
    assert.throws(() => createApi({ agentId: 'claude', cwd: join(plain, 'sub'), configDir }), (e) => e.code === CODES.NOT_INITIALIZED)
    assert.deepEqual(readdirSync(target), [])

    const init = runCli(['init'], { cwd: repo })
    assert.equal(init.status, 1, init.stdout)
    assert.match(init.stderr, /symbolic link/)
    assert.deepEqual(readdirSync(target), [], 'init did not build a journal inside the link target')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('D: an empty .collab is not a journal, and opening it creates nothing', () => {
  const base = tempDir('collab-sec-empty-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const repo = gitRepo(join(base, 'repo'))
    mkdirSync(join(repo, '.collab'))
    assert.throws(() => createApi({ agentId: 'claude', cwd: repo, configDir }), (e) => e.code === CODES.NOT_INITIALIZED && /collab init/.test(e.message))
    assert.deepEqual(readdirSync(join(repo, '.collab')), [])
    const status = runCli(['status'], { cwd: repo })
    assert.equal(status.status, 1)
    assert.match(status.stderr, /NOT_INITIALIZED/)
    assert.deepEqual(readdirSync(join(repo, '.collab')), [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('D: a half-built journal (layout, no marker, no events) and a broken marker are refused', () => {
  const base = tempDir('collab-sec-half-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const repo = gitRepo(join(base, 'repo'))
    for (const dir of LAYOUT) mkdirSync(join(repo, '.collab', dir), { recursive: true })
    assert.throws(() => createApi({ agentId: 'claude', cwd: repo, configDir }), (e) => e.code === CODES.NOT_INITIALIZED)

    writeFileSync(join(repo, '.collab', 'journal.json'), '')
    assert.throws(() => createApi({ agentId: 'claude', cwd: repo, configDir }), (e) => e.code === CODES.NOT_INITIALIZED)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('D: a legacy journal (events.jsonl + collections, no marker) vouched for by the registry opens as it is', async () => {
  const base = tempDir('collab-sec-legacy-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const repo = gitRepo(join(base, 'repo'))
    const registryDir = join(base, 'registry')
    writeJson(join(registryDir, 'old', 'project.json'), { id: 'old', roots: [repo], legacy_journal: true })
    const state = join(repo, '.collab')
    for (const dir of LAYOUT) mkdirSync(join(state, dir), { recursive: true })
    const id = 'tsk_mf3k2p_a91c04'
    writeJson(join(state, 'tasks', `${id}.json`), { id, title: 'Written by the old layer', status: 'created', version: 1, owner: null, files: [], needs_review: true, action: 'edit a file' })
    writeFileSync(join(state, 'events.jsonl'), `${JSON.stringify({ ts: '2026-09-10T12:00:00.000Z', actor: 'claude', type: 'task.created', subject: { collection: 'tasks', id }, data: {} })}\n`)
    const before = readdirSync(state).sort()

    const api = createApi({ agentId: 'claude', cwd: repo, configDir, registryDir })
    assert.equal(api.getTask({ task_id: id }).title, 'Written by the old layer')
    assert.deepEqual(readdirSync(state).sort(), before, 'opening a legacy journal adds no marker')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('D: a journal whose layout entry is a symlink is refused', () => {
  const base = tempDir('collab-sec-inner-link-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    const repo = gitRepo(join(base, 'repo'))
    const state = join(repo, '.collab')
    for (const dir of LAYOUT.filter((d) => d !== 'runs')) mkdirSync(join(state, dir), { recursive: true })
    linkDir(outside, join(state, 'runs'))
    writeFileSync(join(state, 'events.jsonl'), '')
    assert.throws(() => createApi({ agentId: 'claude', cwd: repo, configDir }), (e) => e.code === CODES.NOT_INITIALIZED && /runs/.test(e.message))
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('D: init racing a reader never exposes a half-built journal', async () => {
  const base = tempDir('collab-sec-race-')
  const configDir = writeFixtureConfig(join(base, 'config'))
  try {
    for (let round = 0; round < 3; round += 1) {
      const project = join(base, `p${round}`)
      mkdirSync(project)
      const child = spawn(process.execPath, [CLI, 'init'], { cwd: project, env: cleanEnv({ COLLAB_AGENT_ID: '' }), stdio: 'ignore' })
      let exited = false
      child.on('exit', () => {
        exited = true
      })
      while (!exited) {
        try {
          createApi({ agentId: 'claude', cwd: project, configDir })
          for (const dir of LAYOUT) assert.ok(lstatSync(join(project, '.collab', dir)).isDirectory(), `accepted before ${dir} existed`)
          assert.ok(existsSync(join(project, '.collab', 'journal.json')), 'accepted before the marker was written')
        } catch (error) {
          if (error.code !== CODES.NOT_INITIALIZED) throw error
        }
        await new Promise((r) => setImmediate(r))
      }
      assert.ok(existsSync(join(project, '.collab', 'journal.json')), 'init writes the marker')
      assert.doesNotThrow(() => createApi({ agentId: 'claude', cwd: project, configDir }))
    }
  } finally {
    // A child that failed mid-run may still have the project as its cwd for a moment; Windows will not remove that.
    removeTree(base)
  }
})

// ── E. runner containment is by realpath ──────────────────────────────────

test('E: a runner cwd that is a symlink out of the working tree is refused', async () => {
  const sbx = sandbox()
  try {
    const outside = join(sbx.base, 'outside')
    mkdirSync(outside)
    rmSync(join(sbx.root, 'backend'), { recursive: true, force: true })
    linkDir(outside, join(sbx.root, 'backend'))
    const runner = { ...markerRunner('ran-here'), cwd: 'backend' }
    const configDir = writeFixtureConfig(join(sbx.base, 'cfg-cwd'), { runners: { runners: { 'in-backend': runner } } })
    const { claude } = apis(sbx, { configDir })
    await assert.rejects(claude.startRun({ runner: 'in-backend', wait_seconds: 10 }), (e) => e.code === CODES.RUNNER_REFUSED && /outside the working tree/.test(e.message))
    assert.equal(existsSync(join(outside, 'ran-here')), false)
  } finally {
    sbx.cleanup()
  }
})

test('E: a path argument that resolves out of the tree, or only prefix-matches its directory, is refused', async () => {
  const sbx = sandbox()
  try {
    const outside = join(sbx.base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'evil.test.js'), '')
    const tests = join(sbx.root, 'backend', 'test')
    // A FILE symlink, unlike every other link in this suite — junctions only
    // cover directories, and a real Windows file symlink needs admin/Developer
    // Mode that a CI runner does not grant. Created on POSIX only; the escape
    // this guards against is still exercised on Windows via the directory
    // junction right below (`backend/test/linked/evil.test.js`).
    if (!IS_WINDOWS) symlinkSync(join(outside, 'evil.test.js'), join(tests, 'evil.test.js'))
    linkDir(outside, join(tests, 'linked'))
    mkdirSync(join(sbx.root, 'backend', 'testing'))
    writeFileSync(join(sbx.root, 'backend', 'testing', 'x.test.js'), '')
    writeFileSync(join(tests, 'ok.test.js'), '')

    const runner = {
      summary: 'Checks its path arguments, then prints a TAP summary.',
      cwd: '.',
      command: [process.execPath, 'scripts/tap.mjs'],
      args: { kind: 'paths', min: 1, max: 5, must_be_under: 'backend/test', must_exist: true, must_match: '\\.test\\.js$' },
      timeout_seconds: 30,
      parse: 'tap'
    }
    const configDir = writeFixtureConfig(join(sbx.base, 'cfg-args'), { runners: { runners: { paths: runner } } })
    const { claude } = apis(sbx, { configDir })

    // On Windows 'backend/test/evil.test.js' was never created (see above) —
    // asserting it separately would just be "a nonexistent path is refused",
    // not a proof of symlink-escape refusal.
    const escapeArgs = IS_WINDOWS
      ? ['backend/test/linked/evil.test.js', 'backend/testing/x.test.js']
      : ['backend/test/evil.test.js', 'backend/test/linked/evil.test.js', 'backend/testing/x.test.js']
    for (const arg of escapeArgs) {
      await assert.rejects(claude.startRun({ runner: 'paths', args: [arg], wait_seconds: 10 }), (e) => e.code === CODES.RUNNER_REFUSED, arg)
    }
    const ok = await claude.startRun({ runner: 'paths', args: ['backend/test/ok.test.js'], wait_seconds: 30 })
    assert.equal(ok.status, 'passed', JSON.stringify(ok.result))
  } finally {
    sbx.cleanup()
  }
})

// ── F. a run where nothing ran did not pass ───────────────────────────────

test('F: a TAP run where every test skipped is not recorded as passed', async () => {
  const sbx = sandbox()
  try {
    writeFileSync(
      join(sbx.root, 'scripts', 'skipped.mjs'),
      "process.stdout.write('TAP version 13\\n1..3\\n# tests 3\\n# pass 0\\n# fail 0\\n# skipped 3\\n# todo 0\\n')"
    )
    const runner = { summary: 'Everything skips.', cwd: '.', command: [process.execPath, 'scripts/skipped.mjs'], timeout_seconds: 30, parse: 'tap' }
    const configDir = writeFixtureConfig(join(sbx.base, 'cfg-skip'), { runners: { runners: { skipped: runner } } })
    const { claude } = apis(sbx, { configDir })
    const run = await claude.startRun({ runner: 'skipped', wait_seconds: 30 })
    assert.notEqual(run.status, 'passed')
    assert.equal(run.result.ok, false)
    assert.match(run.result.headline, /NOTHING RAN/)
    assert.ok(claude.listRuns({ failed_only: true }).some((r) => r.id === run.id), 'it shows up among runs that did not pass')
  } finally {
    sbx.cleanup()
  }
})
