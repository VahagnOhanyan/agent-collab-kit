// The record store: reads that never lock, writes that always do.
//
// TWO MECHANISMS, TWO DIFFERENT JOBS — worth spelling out, because the second
// looks redundant until you see what it is for.
//
//   The mutex protects a read-modify-write INSIDE one call. Without it, two
//   processes both read version 3 and both write version 4, and one update
//   vanishes.
//
//   `expected_version` protects a read-modify-write ACROSS calls. An agent
//   reads a task, thinks for two minutes, then writes. The mutex was released
//   long ago and cannot help; the version says "somebody moved this while you
//   were deciding" and the write is refused instead of silently clobbering.
//
// Deleting either one because "the other covers it" is the mistake this comment
// exists to prevent.
//
// A KNOWN NON-PROPERTY: list() is not a consistent snapshot. Each record it
// returns is internally consistent, but a listing taken during a transaction
// may mix records from either side of it. No caller here needs cross-record
// read consistency, and buying it would mean locking reads.

import { existsSync, readdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { CODES, CollabError } from './errors.mjs'
import { appendEvent, readEvents } from './events.mjs'
import { assertValidId, newId, systemClock } from './ids.mjs'
import { readJson, writeJsonAtomic } from './jsonio.mjs'
import { ensureLayout } from './paths.mjs'
import { withLock } from './lock.mjs'

const IN_TRANSACTION = Symbol('collab.inTransaction')

export function createStore({ root, agentId = 'unknown', clock = systemClock, lockOptions = {}, legacyJournal = false } = {}) {
  // Refuses anything that is not an initialised journal: creating one is `collab
  // init`'s job alone, so a store opened in the wrong place fails instead of
  // littering. `legacyJournal` — the registry vouches for a markerless journal.
  const paths = ensureLayout(root, { legacyJournal })
  const state = { [IN_TRANSACTION]: false }

  const recordPath = (collection, id) => paths.record(collection, id)

  function get(collection, id) {
    if (collection !== 'agents') assertValidId(id, `${collection} id`)
    return readJson(recordPath(collection, id))
  }

  function list(collection, { filter = null, sort = null, limit = 0 } = {}) {
    const dir = paths.collection(collection)
    if (!existsSync(dir)) return []
    const out = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const record = readJson(`${dir}/${name}`)
      if (!record) continue
      if (filter && !filter(record)) continue
      out.push(record)
    }
    // Default order is creation order, which for time-prefixed ids is id order.
    out.sort(sort || ((a, b) => String(a.id).localeCompare(String(b.id))))
    return limit > 0 ? out.slice(0, limit) : out
  }

  function makeEvent(type, subject, data) {
    return {
      ts: clock.iso(),
      actor: agentId,
      actor_kind: data && data.actor_kind ? data.actor_kind : 'agent',
      type,
      subject,
      data: data || {}
    }
  }

  // The transaction body. Buffered writes are flushed at the end so a multi-record
  // change (claim = task + agent + event) either all lands or none of it does.
  function makeTx() {
    const writes = []
    const events = []
    return {
      tx: {
        get,
        list,
        now: () => clock.now(),
        iso: () => clock.iso(),
        newId: (collection) => newId(collection, clock),
        create(collection, draft) {
          const id = draft.id || newId(collection, clock)
          const record = {
            ...draft,
            id,
            version: 1,
            created_at: draft.created_at || clock.iso(),
            updated_at: clock.iso()
          }
          writes.push({ collection, record })
          return record
        },
        put(collection, record, { expectedVersion } = {}) {
          const current = get(collection, record.id)
          if (current && expectedVersion !== undefined && current.version !== expectedVersion) {
            throw new CollabError(
              CODES.VERSION_CONFLICT,
              `${collection}/${record.id} moved on: it is at version ${current.version}, you expected ${expectedVersion}`,
              { collection, id: record.id, current_version: current.version, expected_version: expectedVersion, current }
            )
          }
          const next = {
            ...record,
            version: (current ? current.version : 0) + 1,
            updated_at: clock.iso()
          }
          writes.push({ collection, record: next })
          return next
        },
        emit(type, subject, data) {
          const event = makeEvent(type, subject, data)
          events.push(event)
          return event
        }
      },
      commit() {
        for (const { collection, record } of writes) {
          writeJsonAtomic(recordPath(collection, record.id), record, { tmpDir: paths.tmp })
        }
        for (const event of events) appendEvent(paths.events, event)
      }
    }
  }

  async function transact(fn) {
    if (state[IN_TRANSACTION]) {
      // Nesting would deadlock on the file lock if the queue ever changed shape.
      // Failing loudly at development time beats hanging in production.
      throw new CollabError(CODES.REENTRANT_TRANSACTION, 'collab: transact() cannot be nested')
    }
    return withLock(
      paths.lockFile,
      async () => {
        state[IN_TRANSACTION] = true
        try {
          const { tx, commit } = makeTx()
          const result = await fn(tx)
          commit()
          return result
        } finally {
          state[IN_TRANSACTION] = false
        }
      },
      { agentId, ...lockOptions }
    )
  }

  return {
    paths,
    agentId,
    clock,
    get,
    list,
    transact,

    create: (collection, draft) => transact(async (tx) => tx.create(collection, draft)),

    update: (collection, id, mutate, { expectedVersion } = {}) =>
      transact(async (tx) => {
        const current = tx.get(collection, id)
        if (!current) {
          throw new CollabError(CODES.NOT_FOUND, `${collection}/${id} does not exist`, { collection, id })
        }
        const patch = await mutate(current, tx)
        return tx.put(collection, { ...current, ...patch, id: current.id }, { expectedVersion })
      }),

    events: (query) => readEvents(paths.events, query),

    // Written outside a transaction on purpose: this is the crash path, where
    // taking a lock we may never release is worse than a possibly-interleaved line.
    emitUnlocked(type, subject, data) {
      return appendEvent(paths.events, { ...makeEvent(type, subject, data), host: hostname() })
    }
  }
}
