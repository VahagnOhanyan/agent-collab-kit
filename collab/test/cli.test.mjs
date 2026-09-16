// The CLI, run as a real process.
//
// This file exists because of a bug it would have caught: `inbox` called an
// async facade method without awaiting it, so `list.length` was undefined and
// the command cheerfully printed "nothing addressed to codex" while the message
// sat in the ledger. Every assertion below is about the OUTPUT a human reads,
// because that is the thing that was wrong while every unit test was green.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { requestApproval } from '../src/domain/approvals.mjs'
import { LAUNCHER, git, gitRepo, runCli, sandbox, tempDir } from './helpers.mjs'

function scratch({ git = false } = {}) {
  const sbx = sandbox({ git })
  const make = (agentId) => createApi({ agentId, roots: sbx.roots, configDir: sbx.configDir })
  return { sbx, claude: make('claude'), codex: make('codex'), cleanup: sbx.cleanup }
}

// Roots and config go in as main() parameters; env carries only identity tweaks.
const run = (w, args, env = {}) => runCli(args, { cwd: w.sbx.root, env, options: w.sbx.options })

test('inbox prints the message that is actually there', async () => {
  const w = scratch()
  try {
    await w.claude.sendMessage({
      to_agent: 'codex',
      message_type: 'question',
      subject: 'A question for you',
      body: 'Does the registry map every failure path to a tool result?'
    })
    const result = run(w, ['inbox', 'codex'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /claude -> codex/)
    assert.match(result.stdout, /every failure path/)
    assert.doesNotMatch(result.stdout, /nothing addressed/)
  } finally {
    w.cleanup()
  }
})

test('inbox says so honestly when there is nothing', () => {
  const w = scratch()
  try {
    const result = run(w, ['inbox', 'codex'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /nothing addressed to codex/)
  } finally {
    w.cleanup()
  }
})

test('status shows the agents, the tasks and which working tree it looked at', async () => {
  const w = scratch()
  try {
    const task = await w.claude.createTask({ title: 'Something to do', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const result = run(w, ['status'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /claude/)
    assert.match(result.stdout, /codex/)
    assert.match(result.stdout, /in_progress\s+1/)
    assert.match(result.stdout, /working tree/)
    assert.match(result.stdout, /not a git working tree/)
  } finally {
    w.cleanup()
  }
})

test('status in a git project names the worktree, its branch and head', () => {
  const w = scratch({ git: true })
  try {
    const result = run(w, ['status'])
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(`working tree ${w.sbx.root}`), result.stdout)
    assert.match(result.stdout, /@ [0-9a-f]{4,}, \d+ dirty/)
  } finally {
    w.cleanup()
  }
})

test('task shows the review round and its findings', async () => {
  const w = scratch()
  try {
    const task = await w.claude.createTask({ title: 'Reviewed work', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const review = await w.claude.requestReview({ task_id: task.id })
    await w.codex.submitReview({
      review_id: review.review.id,
      verdict: 'changes_requested',
      summary: 'One path is unhandled.',
      findings: [
        { severity: 'major', file: 'a.js', line: 12, note: 'This throw escapes.' },
        {
          severity: 'major',
          file: 'b.js',
          line: 4,
          note: 'The retry loses the cause.',
          evidence: 'the catch at b.js:9 rethrows a new Error without `cause`',
          recommendation: 'pass the original as cause'
        }
      ]
    })
    const result = run(w, ['task', task.id])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /changes_requested/)
    // Severity is left as filed and confidence is printed beside it: a finding
    // with nothing to show for it reads as unproven rather than as a blocker.
    assert.match(result.stdout, /\[major\/hypothesis\] a\.js:12 This throw escapes\./)
    assert.match(result.stdout, /\[major\/likely\] b\.js:4 The retry loses the cause\./)
    assert.match(result.stdout, /shown by: the catch at b\.js:9/)
    assert.match(result.stdout, /do: pass the original as cause/)
  } finally {
    w.cleanup()
  }
})

test('approvals lists what is waiting on the owner, and says how to answer with collab', async () => {
  const w = scratch()
  try {
    await requestApproval(w.codex.ctx, {
      action: 'buy a subscription to the flight data API',
      reason: 'the free tier has no live status',
      cost_estimate: 'about $49/month'
    })
    const result = run(w, ['approvals'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /FINANCIAL/)
    assert.match(result.stdout, /about \$49\/month/)
    assert.match(result.stdout, /requested by codex/)
    assert.match(result.stdout, /collab approve <id>/)
    assert.doesNotMatch(result.stdout, /node tools\/collab/)
  } finally {
    w.cleanup()
  }
})

test('approve REFUSES from an agent shell', async () => {
  const w = scratch()
  try {
    const approval = await requestApproval(w.codex.ctx, { action: 'buy a subscription', reason: 'needed' })
    // Every agent's shell carries COLLAB_AGENT_ID. This is the realistic
    // accident the barrier exists for: an agent pattern-matching on a command
    // it saw in the documentation.
    const result = run(w, ['approve', approval.id], { COLLAB_AGENT_ID: 'codex' })
    assert.equal(result.status, 3)
    assert.match(result.stderr, /COLLAB_AGENT_ID is set/)
    assert.match(result.stderr, /answered by the owner/)

    const still = w.claude.listApprovals({ pending_only: true })
    assert.equal(still.length, 1, 'the approval must still be pending')
    assert.equal(still[0].status, 'pending')
  } finally {
    w.cleanup()
  }
})

test('approve REFUSES without an interactive terminal', async () => {
  const w = scratch()
  try {
    const approval = await requestApproval(w.codex.ctx, { action: 'deploy the backend', reason: 'ship it' })
    // spawnSync gives pipes, not a tty — which is what any script has.
    const result = run(w, ['approve', approval.id])
    assert.equal(result.status, 3)
    assert.match(result.stderr, /needs an interactive terminal/)
    assert.equal(w.claude.listApprovals({ pending_only: true })[0].status, 'pending')
  } finally {
    w.cleanup()
  }
})

test('doctor names the roots, the config source, what is unavailable and how to fix it', () => {
  const w = scratch()
  try {
    const result = run(w, ['doctor'])
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(`journal      ${w.sbx.root}`), result.stdout)
    assert.match(result.stdout, /config\s+config dir/)
    assert.match(result.stdout, /agents/)
    assert.match(result.stdout, /runners/)
    assert.match(result.stdout, /tap-check/)
    // Whether codex is installed on this machine or not, the report must be
    // definite about it rather than silent.
    assert.match(result.stdout, /codex\s+(ok|unavailable)/)
  } finally {
    w.cleanup()
  }
})

test('log prints the audit trail', async () => {
  const w = scratch()
  try {
    const task = await w.claude.createTask({ title: 'Audited', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const result = run(w, ['log', '--tail', '10'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /task\.created/)
    assert.match(result.stdout, /task\.claimed/)
  } finally {
    w.cleanup()
  }
})

test('brief prints what an agent is told about itself, with the briefing file from its config dir', () => {
  const w = scratch()
  try {
    const result = run(w, ['brief', 'codex'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /code_reviewer/)
    assert.match(result.stdout, /independent engineer/)
    // The briefing file is real and reachable, not just a config string.
    assert.match(result.stdout, /submit_review/)
  } finally {
    w.cleanup()
  }
})

test('a command in a folder with no journal says NOT_INITIALIZED, names collab init, and creates nothing', () => {
  const base = tempDir('collab-cli-bare-')
  try {
    const result = runCli(['status'], { cwd: base, options: { registryDir: join(base, 'registry') } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /NOT_INITIALIZED/)
    assert.match(result.stderr, /collab init/)
    assert.equal(existsSync(join(base, '.collab')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the collab launcher is executable and drives the same CLI', () => {
  const w = scratch()
  try {
    // NTFS has no chmod-executable-bit concept, and runCli always invokes the
    // launcher as `node bin/collab` (see helpers.mjs) rather than executing it
    // directly — so there is nothing meaningful to assert here on Windows.
    if (process.platform !== 'win32') assert.ok(statSync(LAUNCHER).mode & 0o111, 'bin/collab must be executable')
    // The real bin/collab, with no parameters: it finds the sandbox journal from cwd.
    const help = runCli(['help'], { cwd: w.sbx.root, launcher: true })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /init\s+create the journal/)
    const status = runCli(['status'], { cwd: w.sbx.root, launcher: true })
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /working tree/)
  } finally {
    w.cleanup()
  }
})

test('I: collab project --json describes the cwd, reports ignored env, and creates nothing', () => {
  const base = tempDir('collab-cli-project-')
  try {
    const repo = gitRepo(join(base, 'repo'))
    mkdirSync(join(repo, 'sub'))
    const worktree = join(base, 'wt')
    git(repo, ['worktree', 'add', '-q', worktree, '-b', 'side'])
    const before = readdirSync(repo).sort()
    const excludeBefore = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')

    const bare = runCli(['project', '--json'], { cwd: join(repo, 'sub') })
    assert.equal(bare.status, 0, bare.stderr)
    const described = JSON.parse(bare.stdout)
    assert.equal(described.journalRoot, repo)
    assert.equal(described.codeRoot, repo)
    assert.equal(described.initialized, false)
    assert.equal(described.projectId, null)
    assert.equal(typeof described.registryDir, 'string')
    assert.equal(described.configSource, 'built-in')
    assert.deepEqual(described.ignoredEnv, [])
    assert.deepEqual(readdirSync(repo).sort(), before, 'nothing was created')
    assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), excludeBefore, 'nothing was written')

    const registry = join(base, 'registry')
    mkdirSync(join(registry, 'demo'), { recursive: true })
    writeFileSync(join(registry, 'demo', 'project.json'), JSON.stringify({ id: 'demo', roots: [repo] }))
    assert.equal(runCli(['init'], { cwd: repo }).status, 0)

    const registered = runCli(['project', '--json'], {
      cwd: worktree,
      options: { registryDir: registry },
      env: { COLLAB_REGISTRY_DIR: join(base, 'nope'), COLLAB_CONFIG_DIR: join(base, 'nope') }
    })
    assert.equal(registered.status, 0, registered.stderr)
    const answer = JSON.parse(registered.stdout)
    assert.equal(answer.journalRoot, repo)
    assert.equal(answer.codeRoot, worktree)
    assert.equal(answer.initialized, true)
    assert.equal(answer.projectId, 'demo')
    assert.equal(answer.registryDir, registry)
    assert.equal(answer.configSource, 'registry')
    assert.deepEqual(answer.ignoredEnv, ['COLLAB_CONFIG_DIR', 'COLLAB_REGISTRY_DIR'])

    const human = runCli(['project'], { cwd: worktree, options: { registryDir: registry } })
    assert.equal(human.status, 0, human.stderr)
    assert.match(human.stdout, /journal\s+/)
    assert.match(human.stdout, /project\s+demo/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an unknown command fails loudly rather than doing nothing', () => {
  const w = scratch()
  try {
    const result = run(w, ['frobnicate'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unknown command/)
  } finally {
    w.cleanup()
  }
})

test('a dirty file that a task claimed is not reported as claimed by nobody', async () => {
  // The regression this holds: `git status --porcelain` starts a line with a
  // space when the file is modified but not staged, and trimming the whole
  // output ate that space on the FIRST line, so its path lost a letter and
  // stopped matching the claim. .collab is excluded here so that the first
  // porcelain line is reliably the file, not the journal directory.
  const w = scratch({ git: true })
  try {
    writeFileSync(join(w.sbx.root, '.git', 'info', 'exclude'), '.collab/\n')
    writeFileSync(join(w.sbx.root, 'alpha.js'), 'one\n')
    git(w.sbx.root, ['add', 'alpha.js'])
    git(w.sbx.root, ['commit', '-q', '-m', 'add alpha'])
    writeFileSync(join(w.sbx.root, 'alpha.js'), 'two\n')

    const task = await w.claude.createTask({ title: 'Work on alpha', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    await w.claude.claimFiles({ task_id: task.id, paths: ['alpha.js'] })

    const result = run(w, ['status'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /claimed alpha\.js/, 'the whole path, and recognised as claimed')
    // The sandbox keeps its own untracked files, so "no task claims" is expected
    // here. What must never appear is a path with its first letter eaten — the
    // form the bug took, and the reason a claimed file stopped matching its claim.
    assert.doesNotMatch(result.stdout, /(^|[^a])lpha\.js/m, 'a path must not lose its first letter')
  } finally {
    w.cleanup()
  }
})
