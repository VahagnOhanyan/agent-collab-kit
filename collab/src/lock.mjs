// The cross-process write mutex. Everything in this layer that mutates state
// passes through here.
//
// WHY A FILE LOCK AND NOT SOMETHING CLEVERER
// Two or three OS processes on one laptop — a Claude Code session, a Codex
// session, the CLI — write the same directory. They share no memory, so the
// mutex has to be something the kernel arbitrates. open(2) with O_CREAT|O_EXCL
// ("wx") is exactly that: it either creates the file or fails EEXIST, and the
// decision is made in the kernel.
//
// WHY `wx` AND NOT mkdir
// mkdir is equally atomic, but a directory has nowhere to put the owner's pid,
// and breaking a stale one is rmSync(recursive), which is not atomic against a
// second process trying to break it at the same moment. With a file, the owner
// metadata is the content, and the break primitive is rename(2) — atomic, so of
// two simultaneous breakers exactly one wins and the other gets ENOENT.
//
// THE METADATA WINDOW
// Between open() and the write of the owner JSON there is an instant where the
// lock file exists and is empty. A reader that treated "unparseable" as "stale"
// would break a lock that was just taken. The rule that closes it is one line:
// an empty or unparseable lock file younger than staleMs is HELD, not stale.
//
// ONE LOCK, NOT ONE PER RECORD
// Critical sections here are sub-millisecond. Per-record locks would buy no
// measurable throughput and would cost a lock-ordering discipline, deadlock
// detection and a stale sweep per file — and would make a multi-record write
// (claim = task + agent + event) something that needs a protocol of its own.
//
// PID REUSE is bounded rather than solved: liveness is combined with an mtime
// ceiling, so a recycled pid can hold a lock falsely for at most staleMs.
// Reading process start times to disambiguate is real machinery for a
// two-agent laptop and is deliberately not here.

import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, futimesSync } from 'node:fs'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { CODES, CollabError } from './errors.mjs'

export const DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  staleMs: 30_000,
  retryBaseMs: 5,
  retryMaxMs: 120
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function readOwner(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8')
    if (!raw.trim()) return { empty: true }
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    return { empty: true } // present but unreadable — treat as the write window
  }
}

// process.kill(pid, 0) is a real existence probe on Windows too (libuv routes
// it through OpenProcess), but the EPERM branch below encodes POSIX cross-user
// permission semantics that do not map cleanly onto Windows access-denied
// errors — kept as the conservative default (treat as alive, never steal a
// lock you're unsure about) on every platform. Whether Windows ever actually
// reaches this branch is for CI (windows-latest, lock.test.mjs's "killed
// holder"/"another host" cases) to settle, not something asserted here.
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user. Alive.
    return error.code === 'EPERM'
  }
}

// Pure, so the decision can be tested without creating files.
export function isStale(owner, mtimeMs, now, staleMs) {
  const age = now - mtimeMs
  if (age > staleMs) return true // a wedged but living holder is still stale
  if (!owner || owner.empty) return false // the metadata window — held
  if (owner.host && owner.host !== hostname()) return false // cannot probe a foreign pid
  return !processAlive(owner.pid)
}

export function acquireSync(lockPath, { agentId = 'unknown', staleMs = DEFAULTS.staleMs } = {}) {
  const token = randomBytes(6).toString('hex')
  try {
    // 0o644 is a no-op on Windows (no POSIX permission bits); the lock's
    // atomicity comes from 'wx' (O_CREAT|O_EXCL), which NTFS honours too.
    const fd = openSync(lockPath, 'wx', 0o644)
    writeSync(
      fd,
      JSON.stringify({ pid: process.pid, host: hostname(), agent: agentId, token, acquired_at: new Date().toISOString() })
    )
    return { fd, path: lockPath, token, acquired: true }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }

  const owner = readOwner(lockPath)
  if (owner === null) return { acquired: false, retry: true } // vanished between calls
  let mtimeMs
  try {
    mtimeMs = statSync(lockPath).mtimeMs
  } catch {
    return { acquired: false, retry: true }
  }

  if (!isStale(owner, mtimeMs, Date.now(), staleMs)) {
    return { acquired: false, retry: true, holder: owner }
  }

  // Break it atomically: the loser of this rename gets ENOENT and simply loops.
  // The winner does NOT assume ownership — it must still win the wx create.
  const parked = `${lockPath}.stale.${token}`
  try {
    renameSync(lockPath, parked)
    unlinkSync(parked)
  } catch {
    // Somebody else broke or released it first. Fine either way.
  }
  return { acquired: false, retry: true, brokeStale: owner }
}

export function releaseSync(handle) {
  if (!handle || !handle.acquired) return
  try {
    closeSync(handle.fd)
  } catch {
    // already closed
  }
  try {
    // Only remove the lock if it is still ours: a stale-break may have replaced it.
    const owner = readOwner(handle.path)
    if (owner && owner.token === handle.token) unlinkSync(handle.path)
  } catch {
    // nothing left to remove
  }
}

export function touchSync(handle) {
  if (!handle || !handle.acquired) return
  try {
    const now = new Date()
    futimesSync(handle.fd, now, now)
  } catch {
    // best effort — a failed touch only risks being judged stale
  }
}

// IN-PROCESS SERIALISATION.
// One MCP server process handles tool calls concurrently, and its own second
// caller would hit EEXIST against its own lock file and spin until timeout.
// A promise chain in front of the file lock makes same-process callers queue
// instead of race. Keyed by path so separate state roots (tests) do not share it.
const queues = new Map()

export async function withLock(lockPath, fn, options = {}) {
  const previous = queues.get(lockPath) || Promise.resolve()
  let release
  const mine = new Promise((resolve) => {
    release = resolve
  })
  queues.set(lockPath, previous.then(() => mine))
  await previous.catch(() => {})

  try {
    return await withFileLock(lockPath, fn, options)
  } finally {
    release()
    if (queues.get(lockPath) === mine) queues.delete(lockPath)
  }
}

async function withFileLock(lockPath, fn, options = {}) {
  const { timeoutMs = DEFAULTS.timeoutMs, staleMs = DEFAULTS.staleMs, agentId = 'unknown' } = options
  const started = Date.now()
  let attempt = 0
  let lastHolder = null

  for (;;) {
    const handle = acquireSync(lockPath, { agentId, staleMs })
    if (handle.acquired) {
      try {
        return await fn()
      } finally {
        releaseSync(handle)
      }
    }
    if (handle.holder) lastHolder = handle.holder

    if (Date.now() - started > timeoutMs) {
      throw new CollabError(
        CODES.LOCK_TIMEOUT,
        `collab: could not take the state lock within ${timeoutMs}ms` +
          (lastHolder ? ` — held by ${lastHolder.agent} (pid ${lastHolder.pid})` : ''),
        { lock_path: lockPath, holder: lastHolder, timeout_ms: timeoutMs }
      )
    }

    const backoff = Math.min(DEFAULTS.retryMaxMs, DEFAULTS.retryBaseMs * 2 ** attempt)
    attempt += 1
    await sleep(backoff * (0.5 + Math.random() * 0.5))
  }
}
