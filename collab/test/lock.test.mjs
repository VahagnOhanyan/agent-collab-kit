// The load-bearing test of this layer.
//
// If the mutex does not hold across processes, every claim, every version bump
// and every audit line above it is unsound, so this is the first thing that has
// to be green and the first thing to look at when something is mysterious.
//
// The negative control is built in: the same workers without a lock lose
// updates on this machine every time. A concurrency test that would pass with
// the protection removed is not testing the protection.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireSync, isStale, readOwner, releaseSync, withLock } from '../src/lock.mjs'
import { CODES } from '../src/errors.mjs'
import { removeTree } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'fixtures', 'lock-worker.mjs')

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-lock-'))
  return { dir, lock: join(dir, 'store.lock'), counter: join(dir, 'counter') }
}

const runWorkers = (count, args) =>
  Promise.all(
    Array.from({ length: count }, () => {
      const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (d) => {
        stderr += d
      })
      return new Promise((resolve, reject) => {
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))))
      })
    })
  )

test('six real processes serialise: no update is lost', async () => {
  const { dir, lock, counter } = scratch()
  writeFileSync(counter, '0')
  try {
    await runWorkers(6, [lock, counter, '40'])
    assert.equal(readFileSync(counter, 'utf8').trim(), '240', 'every one of 6x40 increments must survive')
    assert.equal(existsSync(lock), false, 'the lock file is removed on release')
  } finally {
    removeTree(dir)
  }
})

test('negative control: the same workload without the lock does lose updates', async () => {
  // Proves the assertion above can fail. If this test ever goes green with
  // '240', the first test has stopped testing anything.
  const { dir, counter } = scratch()
  writeFileSync(counter, '0')
  const unlocked = join(dir, 'unlocked-worker.mjs')
  writeFileSync(
    unlocked,
    [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      'const [file, n] = process.argv.slice(2)',
      'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
      'for (let i = 0; i < Number(n); i += 1) {',
      "  const c = Number(readFileSync(file, 'utf8').trim())",
      '  await sleep(1)',
      '  writeFileSync(file, String(c + 1))',
      '}'
    ].join('\n')
  )
  try {
    await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise((resolve) => {
          spawn(process.execPath, [unlocked, counter, '40'], { stdio: 'ignore' }).on('exit', resolve)
        })
      )
    )
    const got = Number(readFileSync(counter, 'utf8').trim())
    assert.ok(got < 240, `expected lost updates without a lock, got the perfect ${got}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a killed holder leaves a stale lock that the next process breaks', async () => {
  const { dir, lock, counter } = scratch()
  writeFileSync(counter, '0')
  try {
    // Forge a lock owned by a pid that is certainly gone.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid = dead.pid
    writeFileSync(
      lock,
      JSON.stringify({ pid: deadPid, host: (await import('node:os')).hostname(), agent: 'ghost', token: 'abc', acquired_at: new Date().toISOString() })
    )
    assert.equal(existsSync(lock), true)

    // staleMs is generous here: the break must come from pid liveness, not from age.
    await withLock(lock, async () => writeFileSync(counter, '1'), { staleMs: 60_000, timeoutMs: 5_000 })
    assert.equal(readFileSync(counter, 'utf8').trim(), '1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live holder is waited for, not broken', async () => {
  const { dir, lock } = scratch()
  try {
    const handle = acquireSync(lock, { agentId: 'holder' })
    assert.equal(handle.acquired, true)
    const owner = readOwner(lock)
    assert.equal(owner.pid, process.pid)
    assert.equal(owner.agent, 'holder')

    // A second acquire in the same process must NOT take it and must NOT break it.
    const second = acquireSync(lock, { agentId: 'other' })
    assert.equal(second.acquired, false)
    assert.equal(second.retry, true)
    assert.equal(second.brokeStale, undefined, 'a lock held by a live pid is never broken')
    releaseSync(handle)
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the metadata window is treated as held, not as stale', () => {
  // An empty lock file younger than staleMs is a lock mid-creation. Judging it
  // stale would break a lock that was taken microseconds ago.
  const now = 1_000_000
  assert.equal(isStale({ empty: true }, now - 100, now, 30_000), false)
  assert.equal(isStale(null, now - 100, now, 30_000), false)
  // Old enough, and it is stale whatever its content says.
  assert.equal(isStale({ empty: true }, now - 60_000, now, 30_000), true)
  // Even a lock whose owner pid is this very process — certainly alive — is
  // stale once it is older than staleMs. That is the wedged-holder case.
  assert.equal(isStale({ pid: process.pid }, now - 60_000, now, 30_000), true)
  assert.equal(isStale({ pid: process.pid }, now - 100, now, 30_000), false)
})

test('a lock held by a live process on another host is not broken by pid probing', () => {
  // We cannot ask another machine whether its pid 1 is alive, so only age may
  // break such a lock. process.pid here is certainly alive locally, which is
  // what makes this a real check rather than a tautology.
  const now = 1_000_000
  const foreign = { pid: 999_999, host: 'some-other-machine' }
  assert.equal(isStale(foreign, now - 100, now, 30_000), false)
  assert.equal(isStale(foreign, now - 60_000, now, 30_000), true)
})

test('a timeout against a genuinely held lock throws LOCK_TIMEOUT with the holder', async () => {
  const { dir, lock, counter } = scratch()
  writeFileSync(counter, '0')
  try {
    // Hold the lock from a CHILD process so the in-process queue cannot help.
    const holder = spawn(process.execPath, [WORKER, lock, counter, '1', '1500'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 400)) // let the child take it

    let error = null
    try {
      await withLock(lock, async () => {}, { timeoutMs: 200, staleMs: 60_000 })
    } catch (e) {
      error = e
    }
    assert.ok(error, 'expected a timeout while a child holds the lock')
    assert.equal(error.code, CODES.LOCK_TIMEOUT)
    assert.match(error.message, /held by worker-\d+/)

    await new Promise((r) => holder.on('exit', r))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two callers inside one process queue instead of racing', async () => {
  const { dir, lock } = scratch()
  const order = []
  try {
    await Promise.all([
      withLock(lock, async () => {
        order.push('a-in')
        await new Promise((r) => setTimeout(r, 30))
        order.push('a-out')
      }),
      withLock(lock, async () => {
        order.push('b-in')
        order.push('b-out')
      })
    ])
    // Whoever goes first, the sections must not interleave.
    assert.deepEqual(order.slice(0, 2), order[0] === 'a-in' ? ['a-in', 'a-out'] : ['b-in', 'b-out'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
