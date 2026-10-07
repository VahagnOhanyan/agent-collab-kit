// Per-task resources a project wants beside a task's working copy — a test
// database of its own, for instance, so two tasks' integration tests do not wipe
// each other's rows in one shared database (wave 2, 07.10: a route test empties a
// whole queue table before it runs).
//
// The project lists the commands in `worktree_hooks` (registry project.json):
//   { "add":    [["createdb", "-T", "app_test", "app_test_{task}"]],
//     "remove": [["dropdb", "--if-exists", "app_test_{task}"]] }
// Each command is an argv list run WITHOUT a shell; `{task}` is the task id
// (letters, digits and `_` only), `{copy}` the copy's absolute path. A failing
// command is reported, not fatal: the copy is still useful without the resource,
// and the project's own test harness decides what to do when it is missing.

import { spawnSync } from 'node:child_process'

const TASK_SAFE = /^[A-Za-z0-9_]+$/

function defaultRun(argv, cwd) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 60_000 })
  return { status: result.status, stderr: result.stderr || (result.error ? String(result.error.message) : '') }
}

export function runWorktreeHooks({ commands, task, copy, cwd, run = defaultRun }) {
  if (!commands || commands.length === 0) return []
  if (!TASK_SAFE.test(task)) return [{ argv: [], status: 'skipped', detail: `task id ${JSON.stringify(task)} is not safe to substitute` }]
  const results = []
  for (const template of commands) {
    const argv = template.map((part) => part.replaceAll('{task}', task).replaceAll('{copy}', copy))
    const out = run(argv, cwd)
    results.push(out.status === 0
      ? { argv, status: 'ok', detail: '' }
      : { argv, status: 'failed', detail: (out.stderr || `exited ${out.status}`).trim().slice(0, 200) })
  }
  return results
}
