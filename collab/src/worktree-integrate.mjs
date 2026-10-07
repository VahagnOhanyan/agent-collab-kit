// `collab worktree integrate` — carrying a task copy's branch into the base branch
// only after it has been rebased onto it AND the project's own checks pass on the
// result.
//
// Why a command and not a habit. A task copy is cut from a base that keeps moving:
// by the time the work is approved, other copies have been merged and the branch is
// no longer what was reviewed *on top of the base as it is now*. Merging it straight
// in puts untested combinations into the shared tree, and the one who then repairs
// them is whoever happens to be standing in that tree (modules.md: whoever repairs
// breaks). The order here is the cheap one: rebase in the copy, run the checks in the
// copy, and move the base branch only with `merge --ff-only` — a base that never
// receives a commit nobody ran the checks against. A red check, a conflict, a dirty
// copy or a main tree standing on another branch all end in a refusal that leaves the
// main tree exactly where it was.
//
// The checks are the project's: `integrate_check` in its registry project.json, argv
// lists run WITHOUT a shell in the copy, `{task}` and `{copy}` substituted like
// worktree_hooks (worktree-hooks.mjs). With none configured the command refuses unless
// the caller says `--no-check`: a missing check must be a decision, not a silent skip.
//
// Git and the commands are injected (`git`, `run`) so the tests drive every refusal
// against a real temporary repository without the machine's own git configuration.

import { spawnSync } from 'node:child_process'
import { CODES, CollabError } from './errors.mjs'
import { gitProbe } from './paths.mjs'

const TASK_SAFE = /^[A-Za-z0-9_]+$/
const CHECK_TIMEOUT_MS = 20 * 60 * 1000
const TAIL_LINES = 40
const TAIL_CHARS = 4000

function defaultRun(argv, cwd, timeoutMs) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  const timedOut = result.error?.code === 'ETIMEDOUT'
  return {
    status: result.error ? -1 : result.status,
    output: `${result.stdout || ''}${result.stderr || ''}${result.error ? `\n${result.error.message}` : ''}`,
    timedOut
  }
}

// A rebase or a fast-forward rewrites a working tree and may run the repository's own hooks: more than a probe's 30 s.
const longGit = (cwd, args) => gitProbe(cwd, args, { timeoutMs: 10 * 60 * 1000 })

function tail(text) {
  const lines = String(text || '').trimEnd().split('\n')
  return lines.slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS)
}

const refuse = (message, details = {}) => new CollabError(CODES.INVALID_INPUT, message, details)

export function integrateWorktree({ mainTree, copy, branch, base = null, task, commands = [], skipCheck = false, run = defaultRun, git = longGit, timeoutMs = CHECK_TIMEOUT_MS }) {
  const ok = (cwd, args) => {
    const r = git(cwd, args)
    if (!r.ok) throw refuse(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || `exited ${r.status}`}`, { cwd })
    return r.stdout.trim()
  }
  if (!branch) throw refuse(`task ${task} has no branch on record — the copy was not made with collab worktree add`, { task })
  if (!TASK_SAFE.test(task)) throw refuse(`task id ${JSON.stringify(task)} is not safe to substitute into a command`, { task })

  // 1. The branch to move. `main`, then `master`, unless the caller named one: guessing further
  // would put the work on whatever the main tree happens to have checked out.
  let target = base
  if (!target) {
    target = ['main', 'master'].find((name) => git(mainTree, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok)
    if (!target) throw refuse('no base branch to integrate into: there is no main or master here — name it with --base <branch>')
  } else if (!git(mainTree, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]).ok) {
    throw refuse(`${target} is not a local branch; --base takes a branch name`, { base: target })
  }

  // 2. The copy is the author's work: everything committed, on its own branch.
  const dirty = ok(copy, ['--no-optional-locks', 'status', '--porcelain'])
  if (dirty) {
    throw refuse(`the copy has uncommitted changes — commit them on ${branch} (a temporary WIP commit is fine) and integrate again; nothing was moved`, {
      copy,
      changes: dirty.split('\n').slice(0, 10)
    })
  }
  const copyHead = git(copy, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (!copyHead.ok || copyHead.stdout.trim() !== branch) {
    throw refuse(`the copy is not on its branch ${branch} (it stands on ${copyHead.ok ? copyHead.stdout.trim() : 'a detached HEAD'}) — check it out there first`, { copy, branch })
  }

  // 3. The main tree must already stand on the base: moving a branch ref under a tree that has
  // another one checked out would leave that tree's files out of step with its HEAD.
  const standing = (() => {
    const r = git(mainTree, ['symbolic-ref', '--short', '-q', 'HEAD'])
    return r.ok ? r.stdout.trim() : null
  })()
  if (standing !== target) {
    throw refuse(`the main tree stands on ${standing || 'a detached HEAD'}, not on the base ${target} — switch it to ${target} (or name the branch it stands on with --base) and integrate again; nothing was moved`, {
      mainTree,
      standing,
      base: target
    })
  }

  if (!commands.length && !skipCheck) {
    throw refuse('this project defines no integrate_check (project.json in the registry), so nothing would prove the rebased branch works — add it, or pass --no-check to integrate without checks, on purpose', { task })
  }

  // 4. Rebase in the copy. A conflict is the author's to resolve in the copy; the attempt is undone so the copy is
  // exactly as it was, and the main tree was never touched.
  const before = ok(mainTree, ['rev-parse', target])
  const rebase = git(copy, ['rebase', target])
  if (!rebase.ok) {
    git(copy, ['rebase', '--abort'])
    throw new CollabError(CODES.GUARD_FAILED, `rebasing ${branch} onto ${target} conflicts — the rebase was aborted and nothing was moved. Rebase in the copy yourself, resolve it, commit, and integrate again`, {
      copy,
      branch,
      base: target,
      output: tail(rebase.stderr)
    })
  }

  // 5. The checks, in the copy, on the rebased result. The first red one stops everything.
  const checks = []
  if (!skipCheck) {
    for (const template of commands) {
      const argv = template.map((part) => part.replaceAll('{task}', task).replaceAll('{copy}', copy))
      const started = Date.now()
      const r = run(argv, copy, timeoutMs)
      const seconds = Math.round((Date.now() - started) / 1000)
      if (r.status !== 0) {
        throw new CollabError(
          CODES.GUARD_FAILED,
          `${r.timedOut ? 'timed out' : `failed (exit ${r.status})`}: ${argv.join(' ')} — ${target} was not moved. Fix it in the copy, commit, and integrate again`,
          { copy, branch, base: target, command: argv, seconds, output: tail(r.output) }
        )
      }
      checks.push({ argv, seconds })
    }
  }

  // 6. Only now the base moves, and only by fast-forward. If it moved while the checks ran, the branch is no longer
  // a descendant, ff-only refuses, and the answer is to run it again — not to merge something nobody tested.
  const stillStanding = git(mainTree, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (!stillStanding.ok || stillStanding.stdout.trim() !== target) {
    throw refuse(`the main tree no longer stands on ${target} — nothing was moved`, { mainTree, base: target })
  }
  const merge = git(mainTree, ['merge', '--ff-only', branch])
  if (!merge.ok) {
    throw new CollabError(CODES.GUARD_FAILED, `${target} could not fast-forward to ${branch} (it moved while the checks ran, or the main tree has local changes in the way) — nothing was moved; integrate again`, {
      mainTree,
      branch,
      base: target,
      output: tail(merge.stderr)
    })
  }
  const after = ok(mainTree, ['rev-parse', target])
  return { base: target, branch, before, after, moved: before !== after, checks, skipped_check: skipCheck, ran_without_project_check: skipCheck && commands.length === 0 }
}
