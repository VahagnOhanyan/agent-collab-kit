// The store's two concurrency mechanisms, and the fact that they are two.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStore } from '../src/store.mjs'
import { CODES } from '../src/errors.mjs'
import { fixedClock } from '../src/ids.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function scratchStore(agentId = 'claude') {
  const dir = mkdtempSync(join(tmpdir(), 'collab-store-'))
  return { dir, store: createStore({ root: dir, agentId, clock: fixedClock() }) }
}

test('create stamps version 1 and an id derived from the collection', async () => {
  const { dir, store } = scratchStore()
  try {
    const task = await store.create('tasks', { title: 'first' })
    assert.equal(task.version, 1)
    assert.match(task.id, /^tsk_[a-z0-9]+_[0-9a-f]{6}$/)
    assert.deepEqual(store.get('tasks', task.id), task)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('update bumps the version and a stale expected_version is refused', async () => {
  const { dir, store } = scratchStore()
  try {
    const task = await store.create('tasks', { title: 'x', status: 'created' })
    const v2 = await store.update('tasks', task.id, () => ({ status: 'assigned' }), { expectedVersion: 1 })
    assert.equal(v2.version, 2)

    let error = null
    try {
      // Somebody else already moved it to version 2; this caller still thinks it is 1.
      await store.update('tasks', task.id, () => ({ status: 'blocked' }), { expectedVersion: 1 })
    } catch (e) {
      error = e
    }
    assert.ok(error, 'a stale expected_version must not silently win')
    assert.equal(error.code, CODES.VERSION_CONFLICT)
    assert.equal(error.details.current_version, 2)
    assert.equal(error.details.expected_version, 1)
    // The current record travels with the error so a retry needs no second read.
    assert.equal(error.details.current.status, 'assigned')
    assert.equal(store.get('tasks', task.id).status, 'assigned', 'the refused write changed nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an update without expected_version is a deliberate last-writer-wins', async () => {
  const { dir, store } = scratchStore()
  try {
    const task = await store.create('tasks', { title: 'x', status: 'created' })
    await store.update('tasks', task.id, () => ({ status: 'assigned' }))
    const after = await store.update('tasks', task.id, () => ({ status: 'blocked' }))
    assert.equal(after.status, 'blocked')
    assert.equal(after.version, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updating something that is not there says so instead of creating it', async () => {
  const { dir, store } = scratchStore()
  try {
    let error = null
    try {
      await store.update('tasks', 'tsk_zzzzzz_abcdef', () => ({ status: 'blocked' }))
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.NOT_FOUND)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a multi-record transaction commits together', async () => {
  const { dir, store } = scratchStore()
  try {
    const { task, message } = await store.transact(async (tx) => {
      const task = tx.create('tasks', { title: 'paired' })
      const message = tx.create('messages', { body: 'about the paired task', task_id: task.id })
      tx.emit('task.created', { collection: 'tasks', id: task.id }, { title: 'paired' })
      return { task, message }
    })
    assert.ok(store.get('tasks', task.id))
    assert.ok(store.get('messages', message.id))
    const events = store.events({ limit: 10 })
    assert.equal(events.at(-1).type, 'task.created')
    assert.equal(events.at(-1).actor, 'claude')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a transaction that throws writes nothing at all', async () => {
  const { dir, store } = scratchStore()
  try {
    let error = null
    try {
      await store.transact(async (tx) => {
        tx.create('tasks', { title: 'doomed' })
        tx.emit('task.created', { collection: 'tasks', id: 'x' }, {})
        throw new Error('boom')
      })
    } catch (e) {
      error = e
    }
    assert.equal(error.message, 'boom')
    assert.equal(store.list('tasks').length, 0, 'the buffered record must not be flushed')
    assert.equal(store.events({ limit: 10 }).length, 0, 'nor the buffered event')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('nesting a transaction fails loudly rather than deadlocking', async () => {
  const { dir, store } = scratchStore()
  try {
    let error = null
    try {
      await store.transact(async () => {
        await store.transact(async () => {})
      })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.REENTRANT_TRANSACTION)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reads do not need the lock: list answers while a writer holds it', async () => {
  // This is the property that keeps `collab status` usable when something is
  // wedged. If a read ever starts taking the mutex, this test hangs.
  const { dir, store } = scratchStore()
  try {
    const task = await store.create('tasks', { title: 'visible' })
    const holder = spawn(
      process.execPath,
      [join(HERE, 'fixtures', 'lock-worker.mjs'), store.paths.lockFile, join(dir, 'counter'), '1', '900'],
      { stdio: 'ignore' }
    )
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'counter'), '0')
    await new Promise((r) => setTimeout(r, 250))

    const listed = store.list('tasks')
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, task.id)
    assert.ok(store.get('tasks', task.id))

    await new Promise((r) => holder.on('exit', r))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two real processes updating the same record lose nothing', async () => {
  const { dir, store } = scratchStore()
  try {
    const task = await store.create('tasks', { title: 'contended', hits: 0 })
    const worker = join(dir, 'bump.mjs')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      worker,
      [
        `import { createStore } from ${JSON.stringify(join(HERE, '..', 'src', 'store.mjs'))}`,
        `const store = createStore({ root: ${JSON.stringify(dir)}, agentId: 'w' + process.pid })`,
        'for (let i = 0; i < 25; i += 1) {',
        `  await store.update('tasks', ${JSON.stringify(task.id)}, (c) => ({ hits: c.hits + 1 }))`,
        '}'
      ].join('\n')
    )
    await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise((resolve, reject) => {
          const c = spawn(process.execPath, [worker], { stdio: ['ignore', 'ignore', 'pipe'] })
          let err = ''
          c.stderr.on('data', (d) => {
            err += d
          })
          c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))))
        })
      )
    )
    const final = store.get('tasks', task.id)
    assert.equal(final.hits, 100, '4 processes x 25 increments, none lost')
    assert.equal(final.version, 101)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the audit log survives a corrupt line instead of hiding it', async () => {
  const { dir, store } = scratchStore()
  try {
    await store.transact(async (tx) => tx.emit('a.b', { collection: 'tasks', id: 'x' }, {}))
    const { appendFileSync } = await import('node:fs')
    appendFileSync(store.paths.events, 'this is not json\n')
    await store.transact(async (tx) => tx.emit('c.d', { collection: 'tasks', id: 'y' }, {}))

    const events = store.events({ limit: 10 })
    assert.deepEqual(events.map((e) => e.type), ['a.b', 'log.unparseable', 'c.d'])
    assert.match(readFileSync(store.paths.events, 'utf8'), /this is not json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
