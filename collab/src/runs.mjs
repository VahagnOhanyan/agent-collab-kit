// Running the project's own checks, and sharing the result between agents.
//
// FOUR RULES, ALL LOAD-BEARING.
//
// 1. Fixed argv, never a shell string. Every runner's command is an array from
//    runners.json and is spawned with shell:false, so there is no argument an
//    agent can craft that becomes a second command. This is the only place in
//    the layer that executes anything, and it is deliberately the narrowest.
//
// 2. Counters, not just the exit code. Node's test runner exits 0 when a whole
//    suite SKIPS, so an agent reading only the exit code cannot tell "passed"
//    from "never ran". The TAP summary is parsed, and a run in which nothing
//    executed is recorded as `nothing_ran`, never as `passed`.
//
// 3. Runners come from configuration only — the built-in set (empty) or the
//    owner's project registry. Nothing in the project repository can add one:
//    these commands run outside any sandbox. They execute in the CALLER'S
//    working tree (ctx.roots.codeRoot), so a check started from a worktree
//    checks that worktree.
//
// 4. Containment is decided on REAL paths, component by component. The runner's
//    cwd and every path argument are resolved through symlinks and must stay
//    under realpath(codeRoot) (and under must_be_under). A lexical check alone
//    lets `backend -> /somewhere/else` walk a runner out of the tree, and a
//    string prefix lets `backend/testing` pass as `backend/test`.
//
// The point of storing the result as a record is that a run is a SHARED fact:
// the reviewer reads the run the author already did instead of spending four
// minutes reproducing it.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { CODES, CollabError } from './errors.mjs'
import { FIXED_PATH, FIXED_PATH_DIRS, isExecutableFile, sanitisedEnv } from './paths.mjs'
import { touchAgent } from './domain/agents.mjs'

const IS_WINDOWS = process.platform === 'win32'
// Windows' CreateProcess refuses to launch a .cmd/.bat file directly — only
// true .exe/.com binaries qualify — so an npm-installed runner shim needs
// shell:true specifically for those two extensions. Everything else (native
// .exe, or any POSIX runner) keeps shell:false, so rule 1's "fixed argv,
// never a shell string" guarantee is unchanged for the common case; even here
// `argv` stays an array and Node quotes each element itself before handing
// the line to cmd.exe, so a runner argument still cannot inject a second
// command the way a hand-built shell string could.
const needsWindowsShell = (executable) => IS_WINDOWS && /\.(cmd|bat)$/i.test(executable)

// 5. The inherited environment is not trusted (a repository's .mcp.json can set
//    it). A bare command name is looked up on the FIXED PATH only, and the child
//    gets a sanitised environment: no GIT_*, NODE_OPTIONS or loader variables,
//    and the fixed PATH. A command given as a path is used as written, relative
//    to the runner's (contained) cwd.

export const NOT_PASSING = Object.freeze(['failed', 'timeout', 'nothing_ran'])

export function listRunners(ctx) {
  return Object.entries(ctx.config.runners.runners).map(([id, def]) => ({
    id,
    summary: def.summary,
    takes_arguments: Boolean(def.args),
    timeout_seconds: def.timeout_seconds
  }))
}

export function within(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

// The real path of `path`: realpath of its deepest existing ancestor with the
// not-yet-existing rest appended. A dangling symlink on the way is null — its
// target cannot be checked, so it is not trusted.
export function realpathLoose(path) {
  const rest = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(current), ...rest)
    } catch {
      try {
        if (lstatSync(current).isSymbolicLink()) return null
      } catch {
        // does not exist at all: keep climbing
      }
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      rest.unshift(basename(current))
      current = parent
    }
  }
}

const refuse = (message, details = {}) => new CollabError(CODES.RUNNER_REFUSED, message, details)

function workingTree(ctx) {
  const codeRoot = ctx.roots?.codeRoot
  if (!codeRoot) throw refuse('there is no working tree to run checks in for this journal')
  try {
    return { codeRoot, realRoot: realpathSync(codeRoot) }
  } catch {
    throw refuse(`the working tree ${codeRoot} is not there`, { worktree: codeRoot })
  }
}

function resolveCommand(command) {
  // A path, not a bare name, needs no PATH lookup — but a Windows relative
  // path (".\scripts\test.cmd") uses "\", which a POSIX-only `/`-check would
  // miss, sending it through the FIXED_PATH_DIRS lookup below by mistake.
  if (isAbsolute(command) || command.includes('/') || command.includes(sep)) return command
  for (const dir of FIXED_PATH_DIRS) {
    const candidate = join(dir, command)
    if (isExecutableFile(candidate)) return candidate
  }
  throw refuse(`"${command}" is not on the fixed PATH (${FIXED_PATH}); runners never look commands up on the inherited PATH`, {
    command
  })
}

function resolveArgs(def, args, { codeRoot, realRoot }) {
  if (!def.args) {
    if (args && args.length) throw refuse('this runner takes no arguments', { given: args })
    return []
  }
  const spec = def.args
  const given = args || []
  if (given.length < (spec.min || 0) || given.length > (spec.max || 20)) {
    throw refuse(`this runner takes between ${spec.min} and ${spec.max} paths, got ${given.length}`, { given })
  }
  const under = spec.must_be_under ? normalize(spec.must_be_under).replace(/[\\/]+$/, '') : null
  const realUnder = under ? realpathLoose(join(codeRoot, under)) : null

  return given.map((raw) => {
    const clean = normalize(String(raw)).replace(/^[\\/]+/, '')
    if (clean.split(/[\\/]/).includes('..')) throw refuse(`"${raw}" walks out of the tree`, { path: raw })
    if (under && clean !== under && !clean.startsWith(`${under}/`)) {
      throw refuse(`"${raw}" is not under ${spec.must_be_under}`, { path: raw })
    }
    if (spec.must_match && !new RegExp(spec.must_match).test(clean)) {
      throw refuse(`"${raw}" does not look like ${spec.must_match}`, { path: raw })
    }
    const real = realpathLoose(join(codeRoot, clean))
    if (!real || !within(realRoot, real)) {
      throw refuse(`"${raw}" resolves outside the working tree`, { path: raw, resolved: real })
    }
    if (under && (!realUnder || !within(realUnder, real))) {
      throw refuse(`"${raw}" resolves outside ${spec.must_be_under}`, { path: raw, resolved: real })
    }
    if (spec.must_exist && !existsSync(join(codeRoot, clean))) throw refuse(`"${raw}" does not exist`, { path: raw })
    return spec.strip_prefix && clean.startsWith(spec.strip_prefix) ? clean.slice(spec.strip_prefix.length) : clean
  })
}

export function parseTap(output) {
  const number = (label) => {
    const match = output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))
    return match ? Number(match[1]) : null
  }
  const tests = number('tests')
  if (tests === null) return null
  return { tests, pass: number('pass'), fail: number('fail'), skipped: number('skipped'), todo: number('todo') }
}

function summarise(def, { code, output, timedOut }) {
  if (timedOut) return { ok: false, headline: `timed out after ${def.timeout_seconds}s` }
  if (def.parse === 'tap') {
    const counts = parseTap(output)
    if (counts) {
      // The distinction that matters: a suite that skipped everything is green
      // by exit code and proves nothing, so it is not a pass.
      const ran = (counts.pass || 0) + (counts.fail || 0)
      const nothingRan = ran === 0
      const ok = code === 0 && counts.fail === 0 && !nothingRan
      const headline = nothingRan
        ? counts.skipped > 0
          ? `NOTHING RAN — ${counts.skipped} skipped (missing service or fixture?)`
          : `NOTHING RAN — ${counts.tests} tests reported, none executed`
        : `${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped of ${counts.tests}`
      return { ok, headline, counts, nothing_ran: nothingRan }
    }
  }
  if (def.parse === 'xcodebuild') {
    const failed = /BUILD FAILED/.test(output)
    const succeeded = /BUILD SUCCEEDED/.test(output)
    return {
      ok: code === 0 && succeeded && !failed,
      headline: succeeded ? 'BUILD SUCCEEDED' : failed ? 'BUILD FAILED' : `xcodebuild exited ${code}`,
      errors: (output.match(/^.*error: .*$/gm) || []).slice(0, 20)
    }
  }
  return { ok: code === 0, headline: code === 0 ? 'exit 0' : `exit ${code}` }
}

export async function startRun(ctx, { runner, args = [], task_id = null, wait_seconds = 20 }) {
  const def = ctx.config.runners.runners[runner]
  if (!def) {
    throw refuse(`there is no runner "${runner}"`, { runner, known: Object.keys(ctx.config.runners.runners) })
  }
  const tree = workingTree(ctx)
  const resolved = resolveArgs(def, args, tree)
  const argv = [...def.command.slice(1), ...resolved]
  const cwd = realpathLoose(resolve(tree.codeRoot, def.cwd || '.'))
  if (!cwd || !within(tree.realRoot, cwd)) {
    throw refuse(`runner "${runner}" would run outside the working tree (cwd "${def.cwd}" resolves to ${cwd})`, {
      cwd: def.cwd,
      resolved: cwd
    })
  }
  const executable = resolveCommand(def.command[0])

  const record = await ctx.store.transact(async (tx) => {
    const run = tx.create('runs', {
      runner,
      args: resolved,
      task_id,
      started_by: ctx.agentId,
      started_at: tx.iso(),
      status: 'running',
      command: [def.command[0], ...argv].join(' '),
      cwd: def.cwd,
      worktree: tree.codeRoot,
      exit_code: null,
      result: null
    })
    touchAgent(tx, ctx)
    tx.emit('run.started', { collection: 'runs', id: run.id }, { runner, args: resolved, task_id })
    return run
  })

  const logFile = ctx.store.paths.runLog(record.id)
  const finished = new Promise((resolve) => {
    const child = spawn(executable, argv, { cwd, shell: needsWindowsShell(executable), env: sanitisedEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, def.timeout_seconds * 1000)

    const collect = (chunk) => {
      output += chunk
      appendFileSync(logFile, chunk)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 127, output: `${output}\n${error.message}`, timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  }).then(async ({ code, output, timedOut }) => {
    const result = summarise(def, { code, output, timedOut })
    return ctx.store.transact(async (tx) => {
      const current = tx.get('runs', record.id)
      const next = tx.put('runs', {
        ...current,
        status: timedOut ? 'timeout' : result.ok ? 'passed' : result.nothing_ran ? 'nothing_ran' : 'failed',
        exit_code: code,
        finished_at: tx.iso(),
        result,
        log_tail: output.split('\n').slice(-40).join('\n')
      })
      tx.emit('run.finished', { collection: 'runs', id: record.id }, {
        runner,
        status: next.status,
        headline: result.headline
      })
      return next
    })
  })

  // Wait a little, so a fast check answers in one call; hand back the id when it
  // does not, so the other agent can watch the same run rather than start its own.
  const raced = await Promise.race([
    finished,
    new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, wait_seconds) * 1000))
  ])
  if (raced) return raced
  finished.catch(() => {})
  return { ...record, status: 'running', hint: `still running — poll get_run with ${record.id}` }
}

export function getRun(ctx, { run_id }) {
  const run = ctx.store.get('runs', run_id)
  if (!run) throw new CollabError(CODES.NOT_FOUND, `no run ${run_id}`, { id: run_id })
  return run
}

// Checks that are red right now: the latest run of each runner for each open task (or with no task) did not pass.
// A failure fixed by a later green run, or one on a finished task, is history, not something to act on.
export function failingNow(ctx, openTaskIds) {
  const latest = new Map()
  for (const run of ctx.store.list('runs')) {
    if (run.task_id && !openTaskIds.has(run.task_id)) continue
    latest.set(`${run.task_id || ''}\u0000${run.runner}`, run)
  }
  return [...latest.values()].filter((run) => NOT_PASSING.includes(run.status))
}

export function listRuns(ctx, { failed_only = false, runner = null, limit = 20 } = {}) {
  return ctx.store
    .list('runs', {
      filter: (r) => {
        if (runner && r.runner !== runner) return false
        if (failed_only && !NOT_PASSING.includes(r.status)) return false
        return true
      }
    })
    .slice(-limit)
}
