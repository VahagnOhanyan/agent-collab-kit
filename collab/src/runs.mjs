// Running the project's own checks, and sharing the result between agents.
//
// TWO RULES, BOTH LOAD-BEARING.
//
// 1. Fixed argv, never a shell string. Every runner's command is an array from
//    runners.json and is spawned with shell:false, so there is no argument an
//    agent can craft that becomes a second command. This is the only place in
//    the layer that executes anything, and it is deliberately the narrowest.
//
// 2. Counters, not just the exit code. Node's test runner exits 0 when a whole
//    suite SKIPS, so an agent reading only the exit code cannot tell "passed"
//    from "never ran" — the very confusion the verify skill warns about. The TAP
//    summary is parsed and `skipped` is reported next to `pass`.
//
// The point of storing the result as a record is that a run is a SHARED fact:
// the reviewer reads the run the author already did instead of spending four
// minutes reproducing it.

import { spawn } from 'node:child_process'
import { existsSync, appendFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { CODES, CollabError } from './errors.mjs'
import { REPO_ROOT } from './paths.mjs'
import { touchAgent } from './domain/agents.mjs'

export function listRunners(ctx) {
  return Object.entries(ctx.config.runners.runners).map(([id, def]) => ({
    id,
    summary: def.summary,
    takes_arguments: Boolean(def.args),
    timeout_seconds: def.timeout_seconds
  }))
}

function resolveArgs(def, args) {
  if (!def.args) {
    if (args && args.length) {
      throw new CollabError(CODES.RUNNER_REFUSED, `this runner takes no arguments`, { given: args })
    }
    return []
  }
  const spec = def.args
  const given = args || []
  if (given.length < (spec.min || 0) || given.length > (spec.max || 20)) {
    throw new CollabError(
      CODES.RUNNER_REFUSED,
      `this runner takes between ${spec.min} and ${spec.max} paths, got ${given.length}`,
      { given }
    )
  }
  return given.map((raw) => {
    const clean = normalize(String(raw)).replace(/^\/+/, '')
    if (clean.includes('..')) {
      throw new CollabError(CODES.RUNNER_REFUSED, `"${raw}" walks out of the tree`, { path: raw })
    }
    if (spec.must_be_under && !clean.startsWith(spec.must_be_under)) {
      throw new CollabError(CODES.RUNNER_REFUSED, `"${raw}" is not under ${spec.must_be_under}`, { path: raw })
    }
    if (spec.must_match && !new RegExp(spec.must_match).test(clean)) {
      throw new CollabError(CODES.RUNNER_REFUSED, `"${raw}" does not look like ${spec.must_match}`, { path: raw })
    }
    if (spec.must_exist && !existsSync(join(REPO_ROOT, clean))) {
      throw new CollabError(CODES.RUNNER_REFUSED, `"${raw}" does not exist`, { path: raw })
    }
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
      const ok = code === 0 && counts.fail === 0
      // The distinction that matters: a suite that skipped everything is green
      // by exit code and proves nothing.
      const ran = counts.pass + counts.fail
      const headline =
        ran === 0 && counts.skipped > 0
          ? `NOTHING RAN — ${counts.skipped} skipped (missing service or fixture?)`
          : `${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped of ${counts.tests}`
      return { ok, headline, counts }
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
    throw new CollabError(CODES.RUNNER_REFUSED, `there is no runner "${runner}"`, {
      runner,
      known: Object.keys(ctx.config.runners.runners)
    })
  }
  const resolved = resolveArgs(def, args)
  const argv = [...def.command.slice(1), ...resolved]
  const cwd = join(REPO_ROOT, def.cwd === '.' ? '' : def.cwd)

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
      exit_code: null,
      result: null
    })
    touchAgent(tx, ctx)
    tx.emit('run.started', { collection: 'runs', id: run.id }, { runner, args: resolved, task_id })
    return run
  })

  const logFile = ctx.store.paths.runLog(record.id)
  const finished = new Promise((resolve) => {
    const child = spawn(def.command[0], argv, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
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
        status: timedOut ? 'timeout' : result.ok ? 'passed' : 'failed',
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

export function listRuns(ctx, { failed_only = false, runner = null, limit = 20 } = {}) {
  return ctx.store
    .list('runs', {
      filter: (r) => {
        if (runner && r.runner !== runner) return false
        if (failed_only && !['failed', 'timeout'].includes(r.status)) return false
        return true
      }
    })
    .slice(-limit)
}
