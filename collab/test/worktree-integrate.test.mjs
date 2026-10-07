// `collab worktree integrate` (worktree-integrate.mjs): rebase the task branch onto the base, run the project's checks
// in the copy, and only then fast-forward the base. Every refusal is proved by a real temporary repository and by the
// base branch NOT moving — the property the command exists for.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { integrateWorktree, failureLines, CHECK_TIMEOUT_MS } from '../src/worktree-integrate.mjs'
import { git, removeTree, runCli, sandbox, tempDir, writeJson } from './helpers.mjs'

const trash = []
after(() => trash.forEach(removeTree))

const NODE = process.execPath
const ok = [NODE, '-e', 'process.exit(0)']
const red = [NODE, '-e', 'console.log("3 tests failed: boom"); process.exit(1)']

// A repository on `main` with one commit, and a task copy on agent/t1 cut from it. The identity is set in the
// repository itself: a rebase writes commits, and the machine running the tests may have no identity of its own.
function world() {
  const base = tempDir('integrate-')
  const main = join(base, 'repo')
  mkdirSync(main)
  git(main, ['init', '-q'])
  git(main, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(main, ['config', 'user.name', 'collab-test'])
  git(main, ['config', 'user.email', 'test@example.invalid'])
  git(main, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(main, 'a.txt'), 'a\n')
  git(main, ['add', '.'])
  git(main, ['commit', '-q', '-m', 'init'])
  const copy = join(base, 'copy')
  git(main, ['worktree', 'add', '-q', copy, '-b', 'agent/t1', 'main'])
  const commit = (dir, file, text, message = `edit ${file}`) => {
    writeFileSync(join(dir, file), text)
    git(dir, ['add', file])
    git(dir, ['commit', '-q', '-m', message])
  }
  const args = (extra = {}) => ({ mainTree: main, copy, branch: 'agent/t1', task: 'tsk_t1', commands: [ok], ...extra })
  const head = (dir, ref = 'HEAD') => git(dir, ['rev-parse', ref])
  trash.push(base)
  return { base, main, copy, commit, args, head }
}

const refuses = (fn, code) => {
  let error = null
  try {
    fn()
  } catch (e) {
    error = e
  }
  assert.ok(error, 'expected a refusal')
  assert.equal(error.code, code, error.message)
  return error
}

test('green: the branch is rebased onto a moved base, the checks run in the copy, and the base fast-forwards to it', () => {
  const w = world()
  w.commit(w.copy, 'b.txt', 'b\n')
  w.commit(w.main, 'c.txt', 'c\n') // the base moved after the copy was cut
  const baseBefore = w.head(w.main)
  const probe = [NODE, '-e', 'require("fs").writeFileSync("seen.txt", process.cwd() + "|" + process.argv.slice(1).join(","))', '{task}', '{copy}']
  const result = integrateWorktree(w.args({ commands: [ok, probe] }))

  assert.equal(result.moved, true)
  assert.equal(result.base, 'main')
  assert.equal(result.before, baseBefore)
  assert.equal(w.head(w.main), w.head(w.copy), 'the base is exactly the rebased branch')
  assert.notEqual(w.head(w.main), baseBefore)
  assert.equal(git(w.main, ['log', '--format=%s', '-3']), 'edit b.txt\nedit c.txt\ninit', 'rebased: the base commit is underneath the task commit')
  assert.ok(existsSync(join(w.main, 'b.txt')) && existsSync(join(w.main, 'c.txt')), 'both changes are in the main tree')
  assert.equal(result.checks.length, 2)
  // cwd is the copy and both placeholders were substituted
  const seen = readFileSync(join(w.copy, 'seen.txt'), 'utf8').split('|')
  assert.equal(seen[0], git(w.copy, ['rev-parse', '--show-toplevel']))
  assert.deepEqual(seen[1].split(','), ['tsk_t1', w.copy])
})

test('red check: the base does not move, and the refusal carries the command and its output', () => {
  const w = world()
  w.commit(w.copy, 'b.txt', 'b\n')
  const baseBefore = w.head(w.main)
  const error = refuses(() => integrateWorktree(w.args({ commands: [ok, red] })), CODES.GUARD_FAILED)
  assert.deepEqual(error.details.command, red)
  assert.match(error.details.output, /3 tests failed: boom/)
  assert.equal(w.head(w.main), baseBefore, 'main did not move')
  assert.equal(existsSync(join(w.main, 'b.txt')), false)
})

test('red check: the refusal names the failing tests even when they are far from the tail', () => {
  const w = world()
  w.commit(w.copy, 'b.txt', 'b\n')
  // A failure early, then thousands of passing lines: the tail alone loses its name.
  const noisy = [NODE, '-e', [
    'console.log("ok 1 - fine");',
    'console.log("not ok 2 - the negative control detects a missing invalidation");',
    'console.log("  not ok 1 - a nested subtest also counts");',
    'for (let i = 3; i < 3000; i++) console.log("ok " + i + " - fine");',
    'console.log("✘ paths in agent instructions");',
    'console.log("# fail 2");',
    'process.exit(1)'
  ].join('')]
  const error = refuses(() => integrateWorktree(w.args({ commands: [noisy] })), CODES.GUARD_FAILED)
  assert.match(error.details.failures, /not ok 2 - the negative control detects a missing invalidation/)
  assert.match(error.details.failures, /not ok 1 - a nested subtest also counts/)
  assert.match(error.details.failures, /✘ paths in agent instructions/)
  assert.match(error.details.failures, /# fail 2/)
  assert.doesNotMatch(error.details.output, /negative control detects/, 'the tail by itself does not carry the name — that is why failures exists')
})

test('failureLines ignores `# fail 0` and repeats, and keeps only naming lines', () => {
  const text = '# fail 0\nnot ok 3 - x\nnot ok 3 - x\nok 4 - y\n✘ gate\nrandom line'
  assert.equal(failureLines(text), 'not ok 3 - x\n✘ gate')
})

test('the default check timeout is ten minutes', () => {
  assert.equal(CHECK_TIMEOUT_MS, 10 * 60 * 1000)
})

test('a check that never starts (no such program) is red as well', () => {
  const w = world()
  w.commit(w.copy, 'b.txt', 'b\n')
  const baseBefore = w.head(w.main)
  refuses(() => integrateWorktree(w.args({ commands: [['definitely-not-a-program-9f3']] })), CODES.GUARD_FAILED)
  assert.equal(w.head(w.main), baseBefore)
})

test('a dirty copy is refused before anything is rebased or moved', () => {
  const w = world()
  w.commit(w.copy, 'b.txt', 'b\n')
  writeFileSync(join(w.copy, 'wip.txt'), 'not committed\n')
  const baseBefore = w.head(w.main)
  const copyBefore = w.head(w.copy)
  const error = refuses(() => integrateWorktree(w.args()), CODES.INVALID_INPUT)
  assert.match(error.message, /uncommitted/)
  assert.equal(w.head(w.main), baseBefore)
  assert.equal(w.head(w.copy), copyBefore)
})

test('the main tree standing on another branch is refused, and so is a base that is not a branch', () => {
  const w = world()
  w.commit(w.copy, 'b.txt', 'b\n')
  git(w.main, ['checkout', '-q', '-b', 'side'])
  const mainBefore = w.head(w.main, 'main')
  const error = refuses(() => integrateWorktree(w.args()), CODES.INVALID_INPUT)
  assert.match(error.message, /stands on side, not on the base main/)
  assert.equal(w.head(w.main, 'main'), mainBefore)
  // naming the branch it stands on is a different base: integrate into side, on purpose
  const result = integrateWorktree(w.args({ base: 'side' }))
  assert.equal(result.base, 'side')
  assert.equal(w.head(w.main, 'main'), mainBefore, 'main itself was never touched')
  refuses(() => integrateWorktree(w.args({ base: 'no-such-branch' })), CODES.INVALID_INPUT)
})

test('a rebase conflict is aborted: the copy is as it was, the base did not move', () => {
  const w = world()
  w.commit(w.copy, 'a.txt', 'copy version\n')
  w.commit(w.main, 'a.txt', 'main version\n')
  const baseBefore = w.head(w.main)
  const copyBefore = w.head(w.copy)
  const error = refuses(() => integrateWorktree(w.args()), CODES.GUARD_FAILED)
  assert.match(error.message, /conflicts/)
  assert.equal(w.head(w.main), baseBefore)
  assert.equal(w.head(w.copy), copyBefore, 'the copy is back on its own commit')
  assert.equal(git(w.copy, ['status', '--porcelain']), '', 'no half-done rebase, no conflict markers left')
  assert.equal(git(w.copy, ['symbolic-ref', '--short', 'HEAD']), 'agent/t1')
})

test('no integrate_check: refused until --no-check is passed on purpose', () => {
  const w = world()
  w.commit(w.copy, 'b.txt', 'b\n')
  const baseBefore = w.head(w.main)
  const error = refuses(() => integrateWorktree(w.args({ commands: [] })), CODES.INVALID_INPUT)
  assert.match(error.message, /integrate_check/)
  assert.match(error.message, /--no-check/)
  assert.equal(w.head(w.main), baseBefore)
  const result = integrateWorktree(w.args({ commands: [], skipCheck: true }))
  assert.equal(result.skipped_check, true)
  assert.equal(result.ran_without_project_check, true)
  assert.equal(w.head(w.main), w.head(w.copy))
})

test('the base moving while the checks run: ff-only refuses, nothing untested is merged', () => {
  const w = world()
  w.commit(w.copy, 'b.txt', 'b\n')
  // the check itself commits to the main tree — somebody else integrating at the same moment
  const racing = [NODE, '-e', `require("child_process").execFileSync("git", ["-C", ${JSON.stringify(w.main)}, "commit", "-q", "--allow-empty", "-m", "other work"])`]
  const error = refuses(() => integrateWorktree(w.args({ commands: [racing] })), CODES.GUARD_FAILED)
  assert.match(error.message, /could not fast-forward/)
  assert.equal(git(w.main, ['log', '--format=%s', '-1']), 'other work')
  assert.equal(existsSync(join(w.main, 'b.txt')), false, 'the branch was not merged')
})

test('a copy that left its own branch (detached) is refused', () => {
  const w = world()
  w.commit(w.copy, 'b.txt', 'b\n')
  git(w.copy, ['checkout', '-q', '--detach'])
  refuses(() => integrateWorktree(w.args()), CODES.INVALID_INPUT)
})

// ── the command ────────────────────────────────────────────────────────────

function cliWorld({ check }) {
  const sbx = sandbox({ git: true })
  git(sbx.root, ['branch', '-M', 'main'])
  git(sbx.root, ['config', 'user.name', 'collab-test'])
  git(sbx.root, ['config', 'user.email', 'test@example.invalid'])
  const registryDir = join(sbx.base, 'registry')
  writeJson(join(registryDir, 'proj', 'project.json'), { id: 'proj', roots: [sbx.root], ...(check ? { integrate_check: check } : {}) })
  const options = { ...sbx.options, registryDir }
  const api = createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir, registryDir })
  const run = (args) => runCli(args, { cwd: sbx.root, options })
  return { sbx, api, run, cleanup: sbx.cleanup }
}

test('collab worktree integrate: green carries the work into main; no integrate_check refuses until --no-check', async () => {
  const w = cliWorld({ check: null })
  try {
    // the main tree keeps its own untracked files (.collab, scripts/): a fast-forward does not care
    const task = await w.api.createTask({ title: 'Album work', action: 'edit a file', needs_review: false })
    await w.api.claimTask({ task_id: task.id })
    const added = w.run(['worktree', 'add', task.id, '--slug', 'album'])
    assert.equal(added.status, 0, added.stderr)
    const copy = w.api.getTask({ task_id: task.id }).worktree
    writeFileSync(join(copy, 'feature.txt'), 'f\n')
    git(copy, ['add', 'feature.txt'])
    git(copy, ['commit', '-q', '-m', 'feature'])
    const mainBefore = git(w.sbx.root, ['rev-parse', 'main'])

    const refused = w.run(['worktree', 'integrate', task.id])
    assert.equal(refused.status, 1, refused.stdout)
    assert.match(refused.stderr, /integrate_check/)
    assert.equal(git(w.sbx.root, ['rev-parse', 'main']), mainBefore)

    const accepted = w.run(['worktree', 'integrate', task.id, '--no-check'])
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(accepted.stdout, /integrated/)
    assert.match(accepted.stdout, /checks skipped/)
    assert.equal(git(w.sbx.root, ['rev-parse', 'main']), git(copy, ['rev-parse', 'HEAD']))
    assert.ok(existsSync(join(w.sbx.root, 'feature.txt')))
  } finally {
    w.cleanup()
  }
})

test('collab worktree integrate: the project\'s integrate_check runs in the copy; red leaves main alone', async () => {
  const w = cliWorld({ check: [[NODE, '-e', 'process.exit(require("fs").existsSync("breaks-it") ? 1 : 0)']] })
  try {
    const task = await w.api.createTask({ title: 'Checked work', action: 'edit a file', needs_review: false })
    await w.api.claimTask({ task_id: task.id })
    assert.equal(w.run(['worktree', 'add', task.id]).status, 0)
    const copy = w.api.getTask({ task_id: task.id }).worktree
    writeFileSync(join(copy, 'breaks-it'), 'x\n')
    git(copy, ['add', 'breaks-it'])
    git(copy, ['commit', '-q', '-m', 'breaks it'])
    const mainBefore = git(w.sbx.root, ['rev-parse', 'main'])

    const red = w.run(['worktree', 'integrate', task.id])
    assert.equal(red.status, 1)
    assert.match(red.stderr, /GUARD_FAILED/)
    assert.equal(git(w.sbx.root, ['rev-parse', 'main']), mainBefore, 'main did not move')

    git(copy, ['rm', '-q', 'breaks-it'])
    git(copy, ['commit', '-q', '-m', 'fix it'])
    const green = w.run(['worktree', 'integrate', task.id])
    assert.equal(green.status, 0, green.stderr)
    assert.match(green.stdout, /ok .*process\.exit/)
    assert.equal(git(w.sbx.root, ['rev-parse', 'main']), git(copy, ['rev-parse', 'HEAD']))
  } finally {
    w.cleanup()
  }
})

test('integrate_check in the registry must be a list of argv lists', () => {
  const sbx = sandbox()
  const registryDir = join(sbx.base, 'registry')
  try {
    const api = createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir, registryDir })
    assert.deepEqual(api.projectSettings().integrate_check, [])
    writeJson(join(registryDir, 'proj', 'project.json'), { id: 'proj', roots: [sbx.root], integrate_check: [['scripts/check.sh', '{copy}']] })
    assert.deepEqual(api.projectSettings().integrate_check, [['scripts/check.sh', '{copy}']])
    for (const bad of ['npm test', [['']], [[]], ['npm', 'test'], [['ok', 3]]]) {
      writeJson(join(registryDir, 'proj', 'project.json'), { id: 'proj', roots: [sbx.root], integrate_check: bad })
      assert.throws(() => api.projectSettings(), (e) => e.code === CODES.CONFIG_INVALID, JSON.stringify(bad))
    }
  } finally {
    sbx.cleanup()
  }
})
