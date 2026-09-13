// Identifiers and time.
//
// Ids are time-prefixed rather than UUIDs on purpose: they end up as file names
// in .collab/ that a human debugs by eye and sorts with `ls`. `tsk_mf3k2p_a91c04`
// tells you what it is and roughly when it happened; a bare UUID tells you
// neither and costs 36 characters to say it.
//
// Time is injected everywhere through a clock so tests can make a lease expire
// without sleeping. Nothing in this layer calls Date.now() directly except the
// default clock below.

import { randomBytes } from 'node:crypto'

export const PREFIXES = Object.freeze({
  tasks: 'tsk',
  messages: 'msg',
  reviews: 'rev',
  decisions: 'dec',
  approvals: 'apr',
  runs: 'run'
})

export const systemClock = Object.freeze({
  now: () => Date.now(),
  iso: () => new Date().toISOString()
})

// A clock frozen at a point, advanced by hand. Tests own their own time.
export function fixedClock(startMs = Date.parse('2026-09-10T12:00:00.000Z')) {
  let current = startMs
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    advance: (ms) => {
      current += ms
      return current
    },
    set: (ms) => {
      current = ms
      return current
    }
  }
}

export function newId(collection, clock = systemClock) {
  const prefix = PREFIXES[collection]
  if (!prefix) throw new Error(`newId: no id prefix registered for collection "${collection}"`)
  return `${prefix}_${clock.now().toString(36)}_${randomBytes(3).toString('hex')}`
}

// File names are derived from ids, so an id that can contain a slash or a dot
// segment is a path traversal. Validate on the way in, once.
const ID_SHAPE = /^[a-z]{3}_[a-z0-9]+_[0-9a-f]{6}$/

export function isValidId(value) {
  return typeof value === 'string' && ID_SHAPE.test(value)
}

export function assertValidId(value, what = 'id') {
  if (!isValidId(value)) {
    throw new Error(`${what}: "${value}" is not a collab id (expected e.g. tsk_mf3k2p_a91c04)`)
  }
  return value
}

// Agent ids come from configuration and from an environment variable, so they
// get the same treatment for the same reason.
const AGENT_SHAPE = /^[a-z][a-z0-9_-]{1,31}$/

export function isValidAgentId(value) {
  return typeof value === 'string' && AGENT_SHAPE.test(value)
}
